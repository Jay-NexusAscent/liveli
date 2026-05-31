import { createHash } from "node:crypto";
import { bqReady } from "@/lib/bigquery";
import { gcp } from "@/lib/gcp";
import { logBqmlUsage } from "@/lib/usage";

/**
 * Privileged BigQuery ML execution path for in-warehouse forecasting and
 * anomaly detection (ARIMA_PLUS).
 *
 * Why this is separate from run_sql / safeQuery: BQML is DDL
 * (`CREATE MODEL`), which the read-only `run_sql` tool MUST never allow.
 * This module is the ONLY place that runs model DDL, and it is narrowly
 * scoped:
 *   - The agent-supplied `sourceSql` is validated to be a single read-only
 *     SELECT (no semicolons, no statement injection).
 *   - Column names are validated as plain identifiers before interpolation.
 *   - Models are written ONLY to a dedicated per-workspace models dataset
 *     the caller can't influence — never a connector's read-only dataset.
 *
 * Cost control (this is cheap by design — see the model below):
 *   - The series is *pre-aggregated* by the agent (GROUP BY a time bucket),
 *     so training scans kilobytes, not the raw table.
 *   - CREATE MODEL is dry-run first and capped at MAX_BYTES_BILLED.
 *   - Models are cached by a fingerprint of their inputs and reused until
 *     MODEL_TTL_MS elapses — repeat asks forecast (near-free) instead of
 *     retraining. Forecast and anomaly detection over the same series
 *     share one model.
 *   - Every train/forecast/detect is logged to usage_events with a GBP
 *     estimate, so spend is visible from day one.
 */

// 6h: bounds staleness regardless of connector syncs. Sync-aware
// invalidation (retrain the moment new data lands) is a future refinement.
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

// Bake a generous max horizon into every model so any request up to this
// many periods reuses the same cached model (horizon is excluded from the
// fingerprint for exactly this reason).
const TRAIN_HORIZON = 365;
export const MAX_HORIZON = 365;

// Same 10 GB ceiling run_sql uses. The aggregated series is far smaller;
// this only fires if the agent forgets to aggregate.
const MAX_BYTES_BILLED = 10 * 1024 * 1024 * 1024;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type DataFrequency =
  | "AUTO"
  | "HOURLY"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY";

export interface ForecastPoint {
  series?: string;
  ts: string;
  value: number;
  lower: number;
  upper: number;
}

export interface ActualPoint {
  series?: string;
  ts: string;
  value: number;
}

export interface ForecastResult {
  trained: boolean;
  modelId: string;
  seriesCount: number;
  historical: ActualPoint[];
  forecast: ForecastPoint[];
}

export interface AnomalyPoint {
  series?: string;
  ts: string;
  value: number;
  lower: number;
  upper: number;
  probability: number;
}

export interface AnomalyResult {
  trained: boolean;
  modelId: string;
  pointsEvaluated: number;
  anomalies: AnomalyPoint[];
}

interface SeriesSpec {
  clientId: string;
  workspaceId: string;
  userId?: string;
  /** Agent-authored SELECT producing the aggregated series. */
  sourceSql: string;
  timeColumn: string;
  valueColumn: string;
  seriesColumn?: string;
  dataFrequency?: DataFrequency;
  /** BQML holiday_region (already validated by the caller), or undefined. */
  holidayRegion?: string;
  /** Workspace BQ residency: "EU" | "US". */
  location: string;
}

export interface ForecastSpec extends SeriesSpec {
  horizon: number;
  confidenceLevel?: number;
}

export interface AnomalySpec extends SeriesSpec {
  /** Probability above which a point is flagged. Higher → fewer, more confident. */
  anomalyProbThreshold?: number;
}

// ── Validation ─────────────────────────────────────────────────────

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function modelsDatasetId(clientId: string, workspaceId: string): string {
  return `c_${slug(clientId)}__w_${slug(workspaceId)}__models`;
}

function assertIdentifier(name: string, label: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `${label} must be a plain column name (letters, digits, underscores). Got: ${name}`
    );
  }
}

function validateSourceSql(sql: string): string {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (s.includes(";")) {
    throw new Error("source_sql must be a single SELECT statement (no semicolons).");
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(s)) {
    throw new Error("source_sql must be a read-only query starting with SELECT or WITH.");
  }
  return s;
}

function mapFrequency(f?: DataFrequency): string {
  switch ((f ?? "AUTO").toUpperCase()) {
    case "HOURLY": return "HOURLY";
    case "DAILY": return "DAILY";
    case "WEEKLY": return "WEEKLY";
    case "MONTHLY": return "MONTHLY";
    case "QUARTERLY": return "QUARTERLY";
    case "YEARLY": return "YEARLY";
    default: return "AUTO_FREQUENCY";
  }
}

// ── Cell coercion (BQ returns TIMESTAMP/DATE/NUMERIC as wrapper objects) ──

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    return String((v as { value: unknown }).value);
  }
  return String(v);
}

function cellNum(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    return Number((v as { value: unknown }).value);
  }
  return Number(v);
}

// ── Job execution ──────────────────────────────────────────────────

interface JobResult {
  rows: Record<string, unknown>[];
  bytesProcessed: number;
}

async function runQuery(
  sql: string,
  location: string,
  opts: { dryRunFirst?: boolean; maxRows?: number; params?: Record<string, unknown> } = {}
): Promise<JobResult> {
  const client = await bqReady();

  if (opts.dryRunFirst) {
    const [dry] = await client.createQueryJob({
      query: sql,
      location,
      dryRun: true,
      ...(opts.params ? { params: opts.params } : {}),
    });
    const estimated = Number(dry.metadata.statistics?.totalBytesProcessed ?? 0);
    if (estimated > MAX_BYTES_BILLED) {
      throw new Error(
        `This would scan ${(estimated / 1e9).toFixed(2)} GB (limit ${(MAX_BYTES_BILLED / 1e9).toFixed(0)} GB). Aggregate the series further (coarser time bucket / fewer groups) before forecasting.`
      );
    }
  }

  const [job] = await client.createQueryJob({
    query: sql,
    location,
    maximumBytesBilled: String(MAX_BYTES_BILLED),
    ...(opts.params ? { params: opts.params } : {}),
  });
  const [rows] = await job.getQueryResults({ maxResults: opts.maxRows ?? 5000 });
  const [meta] = await job.getMetadata();
  const bytesProcessed = Number(meta.statistics?.totalBytesProcessed ?? 0);
  return { rows: rows as Record<string, unknown>[], bytesProcessed };
}

// ── Model lifecycle ────────────────────────────────────────────────

/**
 * Deterministic model id from the inputs that define the trained model.
 * The FIRST element is treated as SQL and whitespace-normalized so cosmetic
 * reformatting of the agent's query doesn't bust the cache; the rest are
 * compared verbatim. Inputs that only affect *reading* the model (forecast
 * horizon, scoring threshold, which class is "positive") MUST be excluded —
 * they don't change the model, and excluding them lets repeat asks reuse it.
 */
function hashParts(sqlPart: string, ...rest: string[]): string {
  const normalized = sqlPart.replace(/\s+/g, " ").trim();
  const hash = createHash("sha256")
    .update(JSON.stringify([normalized, ...rest]))
    .digest("hex")
    .slice(0, 16);
  return `m_${hash}`;
}

function fingerprint(spec: {
  sourceSql: string;
  timeColumn: string;
  valueColumn: string;
  seriesColumn?: string;
  dataFrequency: string;
  holidayRegion?: string;
}): string {
  return hashParts(
    spec.sourceSql,
    spec.timeColumn,
    spec.valueColumn,
    spec.seriesColumn ?? "",
    spec.dataFrequency,
    spec.holidayRegion ?? ""
  );
}

async function ensureModelsDataset(datasetId: string, location: string): Promise<void> {
  const client = await bqReady();
  const ds = client.dataset(datasetId);
  const [exists] = await ds.exists();
  if (exists) return;
  try {
    await ds.create({ location });
  } catch (err) {
    // 409 = created by a concurrent forecast call. Anything else is real.
    if ((err as { code?: number })?.code !== 409) throw err;
  }
}

function buildCreateModelSql(args: {
  datasetId: string;
  modelId: string;
  timeColumn: string;
  valueColumn: string;
  seriesColumn?: string;
  dataFrequency: string;
  holidayRegion?: string;
  sourceSql: string;
}): string {
  const fq = `\`${gcp.projectId}.${args.datasetId}.${args.modelId}\``;
  const options = [
    "model_type = 'ARIMA_PLUS'",
    `time_series_timestamp_col = '${args.timeColumn}'`,
    `time_series_data_col = '${args.valueColumn}'`,
    args.seriesColumn ? `time_series_id_col = '${args.seriesColumn}'` : null,
    `horizon = ${TRAIN_HORIZON}`,
    "auto_arima = TRUE",
    `data_frequency = '${args.dataFrequency}'`,
    args.holidayRegion ? `holiday_region = '${args.holidayRegion}'` : null,
    "clean_spikes_and_dips = TRUE",
    "adjust_step_changes = TRUE",
    "decompose_time_series = TRUE",
  ]
    .filter(Boolean)
    .join(",\n  ");
  return `CREATE OR REPLACE MODEL ${fq}\nOPTIONS(\n  ${options}\n) AS (\n${args.sourceSql}\n)`;
}

function translateTrainingError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not enough|insufficient|too few|at least \d+ (data )?points/i.test(msg)) {
    return new Error(
      "Not enough history to model this series. ARIMA needs a longer run of regular data points — try a coarser time grain (weekly/monthly) or a metric with more history."
    );
  }
  if (/TIMESTAMP|DATE|DATETIME|must be of type|cannot be|numeric/i.test(msg)) {
    return new Error(
      "The time column must be DATE/TIMESTAMP and the value column numeric. Adjust source_sql (e.g. CAST the value to FLOAT64, or bucket the timestamp with DATE())."
    );
  }
  return new Error(`Model training failed: ${msg}`);
}

interface TrainOutcome {
  trained: boolean;
  bytesProcessed: number;
  executionMs: number;
}

/**
 * Train the model from the given DDL if it's missing or older than the TTL;
 * otherwise reuse the cached one. Model-type-agnostic — the caller builds the
 * `CREATE MODEL` SQL and supplies a translator that turns a raw BigQuery
 * training error into a customer-readable hint.
 */
async function ensureModelDdl(
  datasetId: string,
  modelId: string,
  ddl: string,
  location: string,
  translateError: (err: unknown) => Error
): Promise<TrainOutcome> {
  const client = await bqReady();
  const model = client.dataset(datasetId).model(modelId);
  const [exists] = await model.exists();
  if (exists) {
    const [meta] = await model.getMetadata();
    const created = Number(meta.creationTime ?? 0);
    if (created && Date.now() - created < MODEL_TTL_MS) {
      return { trained: false, bytesProcessed: 0, executionMs: 0 };
    }
  }

  const startedAt = Date.now();
  let result: JobResult;
  try {
    result = await runQuery(ddl, location, { dryRunFirst: true, maxRows: 0 });
  } catch (err) {
    throw translateError(err);
  }
  return {
    trained: true,
    bytesProcessed: result.bytesProcessed,
    executionMs: Date.now() - startedAt,
  };
}

/** Train the ARIMA_PLUS series model if missing or stale; else reuse cached. */
async function ensureModel(
  datasetId: string,
  modelId: string,
  spec: Omit<SeriesSpec, "dataFrequency"> & { dataFrequency: string }
): Promise<TrainOutcome> {
  const ddl = buildCreateModelSql({
    datasetId,
    modelId,
    timeColumn: spec.timeColumn,
    valueColumn: spec.valueColumn,
    seriesColumn: spec.seriesColumn,
    dataFrequency: spec.dataFrequency,
    holidayRegion: spec.holidayRegion,
    sourceSql: spec.sourceSql,
  });
  return ensureModelDdl(datasetId, modelId, ddl, spec.location, translateTrainingError);
}

// ── Shared preparation ─────────────────────────────────────────────

function prepare(spec: SeriesSpec): {
  datasetId: string;
  modelId: string;
  sourceSql: string;
  dataFrequency: string;
} {
  assertIdentifier(spec.timeColumn, "time_column");
  assertIdentifier(spec.valueColumn, "value_column");
  if (spec.seriesColumn) assertIdentifier(spec.seriesColumn, "series_column");
  const sourceSql = validateSourceSql(spec.sourceSql);
  const dataFrequency = mapFrequency(spec.dataFrequency);
  const datasetId = modelsDatasetId(spec.clientId, spec.workspaceId);
  const modelId = fingerprint({
    sourceSql,
    timeColumn: spec.timeColumn,
    valueColumn: spec.valueColumn,
    seriesColumn: spec.seriesColumn,
    dataFrequency,
    holidayRegion: spec.holidayRegion,
  });
  return { datasetId, modelId, sourceSql, dataFrequency };
}

function seriesIdOf(
  row: Record<string, unknown>,
  seriesColumn: string | undefined
): string | undefined {
  if (!seriesColumn) return undefined;
  // ML.FORECAST may surface the id under its original name or "time_series_id".
  const raw = row[seriesColumn] ?? row["time_series_id"];
  return raw === undefined ? undefined : cellStr(raw);
}

// ── Public API ─────────────────────────────────────────────────────

export async function runForecast(spec: ForecastSpec): Promise<ForecastResult> {
  if (spec.horizon < 1 || spec.horizon > MAX_HORIZON) {
    throw new Error(`horizon must be between 1 and ${MAX_HORIZON}.`);
  }
  const { datasetId, modelId, sourceSql, dataFrequency } = prepare(spec);
  const preparedSpec: Omit<SeriesSpec, "dataFrequency"> & { dataFrequency: string } = {
    ...spec,
    sourceSql,
    dataFrequency,
  };

  await ensureModelsDataset(datasetId, spec.location);
  const train = await ensureModel(datasetId, modelId, preparedSpec);
  if (train.trained) {
    logBqmlUsage({
      eventType: "model.train",
      clientId: spec.clientId,
      workspaceId: spec.workspaceId,
      userId: spec.userId,
      resource: modelId,
      bytesScanned: train.bytesProcessed,
      executionMs: train.executionMs,
    });
  }

  const fq = `\`${gcp.projectId}.${datasetId}.${modelId}\``;
  const confidence = spec.confidenceLevel ?? 0.95;
  const forecastSql = `SELECT * FROM ML.FORECAST(MODEL ${fq}, STRUCT(${spec.horizon} AS horizon, ${confidence} AS confidence_level))`;
  const histSql = `SELECT * FROM (\n${sourceSql}\n) ORDER BY ${spec.timeColumn}`;

  const startedAt = Date.now();
  const [fc, hist] = await Promise.all([
    runQuery(forecastSql, spec.location, { maxRows: 5000 }),
    runQuery(histSql, spec.location, { maxRows: 5000 }),
  ]);

  logBqmlUsage({
    eventType: "forecast.run",
    clientId: spec.clientId,
    workspaceId: spec.workspaceId,
    userId: spec.userId,
    resource: modelId,
    bytesScanned: fc.bytesProcessed + hist.bytesProcessed,
    executionMs: Date.now() - startedAt,
  });

  const forecast: ForecastPoint[] = fc.rows.map((r) => ({
    series: seriesIdOf(r, spec.seriesColumn),
    ts: cellStr(r["forecast_timestamp"]),
    value: cellNum(r["forecast_value"]),
    lower: cellNum(r["prediction_interval_lower_bound"]),
    upper: cellNum(r["prediction_interval_upper_bound"]),
  }));

  const historical: ActualPoint[] = hist.rows.map((r) => ({
    series: spec.seriesColumn ? cellStr(r[spec.seriesColumn]) : undefined,
    ts: cellStr(r[spec.timeColumn]),
    value: cellNum(r[spec.valueColumn]),
  }));

  const seriesCount = spec.seriesColumn
    ? new Set(forecast.map((f) => f.series)).size
    : 1;

  return { trained: train.trained, modelId, seriesCount, historical, forecast };
}

export async function runAnomalyDetection(spec: AnomalySpec): Promise<AnomalyResult> {
  const { datasetId, modelId, sourceSql, dataFrequency } = prepare(spec);
  const preparedSpec: Omit<SeriesSpec, "dataFrequency"> & { dataFrequency: string } = {
    ...spec,
    sourceSql,
    dataFrequency,
  };

  await ensureModelsDataset(datasetId, spec.location);
  const train = await ensureModel(datasetId, modelId, preparedSpec);
  if (train.trained) {
    logBqmlUsage({
      eventType: "model.train",
      clientId: spec.clientId,
      workspaceId: spec.workspaceId,
      userId: spec.userId,
      resource: modelId,
      bytesScanned: train.bytesProcessed,
      executionMs: train.executionMs,
    });
  }

  const fq = `\`${gcp.projectId}.${datasetId}.${modelId}\``;
  const threshold = spec.anomalyProbThreshold ?? 0.95;
  const sql = `SELECT * FROM ML.DETECT_ANOMALIES(MODEL ${fq}, STRUCT(${threshold} AS anomaly_prob_threshold))`;

  const startedAt = Date.now();
  const res = await runQuery(sql, spec.location, { maxRows: 5000 });

  logBqmlUsage({
    eventType: "anomaly.detect",
    clientId: spec.clientId,
    workspaceId: spec.workspaceId,
    userId: spec.userId,
    resource: modelId,
    bytesScanned: res.bytesProcessed,
    executionMs: Date.now() - startedAt,
  });

  const anomalies: AnomalyPoint[] = res.rows
    .filter((r) => r["is_anomaly"] === true)
    .map((r) => ({
      series: seriesIdOf(r, spec.seriesColumn),
      ts: cellStr(r[spec.timeColumn]),
      value: cellNum(r[spec.valueColumn]),
      lower: cellNum(r["lower_bound"]),
      upper: cellNum(r["upper_bound"]),
      probability: cellNum(r["anomaly_probability"]),
    }));

  return {
    trained: train.trained,
    modelId,
    pointsEvaluated: res.rows.length,
    anomalies,
  };
}

// ── Binary classification (LOGISTIC_REG) ───────────────────────────

export interface ClassificationMetrics {
  rocAuc: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  logLoss: number;
}

/** A feature and its standardized logistic-regression coefficient. */
export interface FeatureWeight {
  feature: string;
  /** Standardized weight — magnitude is comparable across features; sign is
   * the direction of association with the positive class. */
  weight: number;
}

export interface ScoredEntity {
  id: string;
  predictedLabel: string;
  /** P(positive class), or NaN if positive_label matched no class. */
  probability: number;
}

export interface ClassificationResult {
  trained: boolean;
  modelId: string;
  metrics: ClassificationMetrics;
  weights: FeatureWeight[];
  /** Top entities ranked by P(positive). Present only when both id_column and
   * positive_label were supplied. */
  topRisk?: ScoredEntity[];
}

export interface ClassificationSpec {
  clientId: string;
  workspaceId: string;
  userId?: string;
  /** Agent-authored SELECT: feature columns + one binary label column
   * (+ optionally one id column, which is excluded from features). */
  sourceSql: string;
  /** Name of the binary label column (exactly two distinct values). */
  labelColumn: string;
  /** Optional entity-id column — kept out of features, used to rank scores. */
  idColumn?: string;
  /** Which label value is the event of interest (e.g. 'churned', 'true', '1').
   * Required to rank entities by risk; compared as a string. */
  positiveLabel?: string;
  /** How many ranked entities to return when scoring. Default 100. */
  topN?: number;
  /** Workspace BQ residency: "EU" | "US". */
  location: string;
}

function buildClassifierDdl(args: {
  datasetId: string;
  modelId: string;
  labelColumn: string;
  idColumn?: string;
  sourceSql: string;
}): string {
  const fq = `\`${gcp.projectId}.${args.datasetId}.${args.modelId}\``;
  // The id is an identifier for scoring, NOT a predictor — exclude it from the
  // feature set. Everything else the SELECT returns (besides the label) is a
  // feature, so the tool stays schema-agnostic.
  const trainingSelect = args.idColumn
    ? `SELECT * EXCEPT(\`${args.idColumn}\`) FROM (\n${args.sourceSql}\n)`
    : args.sourceSql;
  const options = [
    "model_type = 'LOGISTIC_REG'",
    `input_label_cols = ['${args.labelColumn}']`,
    // Churn/fraud labels are usually imbalanced; class weighting stops the
    // model from trivially predicting the majority class.
    "auto_class_weights = TRUE",
    "data_split_method = 'AUTO_SPLIT'",
  ].join(",\n  ");
  return `CREATE OR REPLACE MODEL ${fq}\nOPTIONS(\n  ${options}\n) AS (\n${trainingSelect}\n)`;
}

function translateClassificationError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/input_label_cols|label column|not found|unrecognized name/i.test(msg)) {
    return new Error(
      "Couldn't find the label column. source_sql must return a binary label column named exactly as label_column, plus the feature columns (and optionally an id column)."
    );
  }
  if (/two|binary|distinct|number of classes|more than/i.test(msg)) {
    return new Error(
      "Binary classification needs a label with exactly two classes. Collapse the label to two values first, e.g. CASE WHEN status = 'cancelled' THEN 'churned' ELSE 'active' END AS churn_label."
    );
  }
  return new Error(`Model training failed: ${msg}`);
}

export async function runClassification(
  spec: ClassificationSpec
): Promise<ClassificationResult> {
  assertIdentifier(spec.labelColumn, "label_column");
  if (spec.idColumn) assertIdentifier(spec.idColumn, "id_column");
  const sourceSql = validateSourceSql(spec.sourceSql);
  const datasetId = modelsDatasetId(spec.clientId, spec.workspaceId);
  // id_column changes which columns are features, so it's part of model
  // identity. positive_label and topN only affect scoring (reading the model),
  // so they're excluded — re-scoring reuses the cached model.
  const modelId = hashParts(
    sourceSql,
    spec.labelColumn,
    spec.idColumn ?? "",
    "LOGISTIC_REG"
  );

  await ensureModelsDataset(datasetId, spec.location);
  const ddl = buildClassifierDdl({
    datasetId,
    modelId,
    labelColumn: spec.labelColumn,
    idColumn: spec.idColumn,
    sourceSql,
  });
  const train = await ensureModelDdl(
    datasetId,
    modelId,
    ddl,
    spec.location,
    translateClassificationError
  );
  if (train.trained) {
    logBqmlUsage({
      eventType: "model.train",
      clientId: spec.clientId,
      workspaceId: spec.workspaceId,
      userId: spec.userId,
      resource: modelId,
      bytesScanned: train.bytesProcessed,
      executionMs: train.executionMs,
    });
  }

  const fq = `\`${gcp.projectId}.${datasetId}.${modelId}\``;
  const evalSql = `SELECT * FROM ML.EVALUATE(MODEL ${fq})`;
  // Standardized weights so magnitude ranks feature influence regardless of
  // each feature's native scale. Categorical features surface their weight via
  // category_weights (NULL `weight`); v1 reports the numeric/standardized set.
  const weightsSql =
    `SELECT processed_input AS feature, weight ` +
    `FROM ML.WEIGHTS(MODEL ${fq}, STRUCT(TRUE AS standardize)) ` +
    `WHERE weight IS NOT NULL ORDER BY ABS(weight) DESC LIMIT 25`;

  const wantScore = Boolean(spec.idColumn && spec.positiveLabel);

  const startedAt = Date.now();
  const jobs: Promise<JobResult>[] = [
    runQuery(evalSql, spec.location, { maxRows: 1 }),
    runQuery(weightsSql, spec.location, { maxRows: 25 }),
  ];
  if (wantScore) {
    const lbl = spec.labelColumn;
    const topN = spec.topN ?? 100;
    // positive_label is arbitrary user data → bind as a query parameter, never
    // interpolate. predicted_<label>_probs is an ARRAY<STRUCT<label, prob>>;
    // pull the row for the positive class.
    const scoreSql =
      `SELECT \`${spec.idColumn}\` AS id, ` +
      `CAST(predicted_${lbl} AS STRING) AS predicted_label, ` +
      `(SELECT p.prob FROM UNNEST(predicted_${lbl}_probs) AS p ` +
      `WHERE CAST(p.label AS STRING) = @pos) AS probability ` +
      `FROM ML.PREDICT(MODEL ${fq}, (\n${sourceSql}\n)) ` +
      `ORDER BY probability DESC LIMIT ${topN}`;
    jobs.push(
      runQuery(scoreSql, spec.location, {
        maxRows: topN,
        params: { pos: spec.positiveLabel },
      })
    );
  }

  const results = await Promise.all(jobs);
  const [evalRes, weightsRes] = results;
  const scoreRes = wantScore ? results[2] : undefined;

  const bytes =
    evalRes.bytesProcessed +
    weightsRes.bytesProcessed +
    (scoreRes?.bytesProcessed ?? 0);
  logBqmlUsage({
    eventType: "classify.run",
    clientId: spec.clientId,
    workspaceId: spec.workspaceId,
    userId: spec.userId,
    resource: modelId,
    bytesScanned: bytes,
    executionMs: Date.now() - startedAt,
  });

  const m: Record<string, unknown> = evalRes.rows[0] ?? {};
  const metrics: ClassificationMetrics = {
    rocAuc: cellNum(m["roc_auc"]),
    accuracy: cellNum(m["accuracy"]),
    precision: cellNum(m["precision"]),
    recall: cellNum(m["recall"]),
    f1: cellNum(m["f1_score"]),
    logLoss: cellNum(m["log_loss"]),
  };

  const weights: FeatureWeight[] = weightsRes.rows.map((r) => ({
    feature: cellStr(r["feature"]),
    weight: cellNum(r["weight"]),
  }));

  const topRisk: ScoredEntity[] | undefined = scoreRes?.rows.map((r) => ({
    id: cellStr(r["id"]),
    predictedLabel: cellStr(r["predicted_label"]),
    probability: cellNum(r["probability"]),
  }));

  return { trained: train.trained, modelId, metrics, weights, topRisk };
}

// ── Clustering / segmentation (KMEANS) ─────────────────────────────

/** One cluster's centroid profile: its size plus the centroid value of each
 * feature, so the agent can describe what makes the segment distinct. */
export interface ClusterProfile {
  cluster: number;
  size: number;
  /** Centroid value per feature. Numeric features → the mean; categorical →
   * the dominant category label. */
  features: Record<string, number | string>;
}

export interface ClusterAssignment {
  id: string;
  cluster: number;
  /** Distance to the assigned centroid — smaller means a tighter fit. */
  distance: number;
}

export interface ClusteringResult {
  trained: boolean;
  modelId: string;
  numClusters: number;
  profiles: ClusterProfile[];
  /** A capped sample of entity→cluster assignments. Present only when an
   * id_column was supplied. */
  assignments?: ClusterAssignment[];
}

export interface ClusteringSpec {
  clientId: string;
  workspaceId: string;
  userId?: string;
  /** Agent-authored SELECT: one row per entity, feature columns to cluster on
   * (+ optionally one id column, excluded from the feature set). */
  sourceSql: string;
  /** Optional entity-id column — kept out of features, used to label rows. */
  idColumn?: string;
  /** Desired number of segments. Omit to let BigQuery pick automatically. */
  numClusters?: number;
  /** How many entity→cluster assignments to sample back. Default 200. */
  topN?: number;
  /** Workspace BQ residency: "EU" | "US". */
  location: string;
}

function buildClustererDdl(args: {
  datasetId: string;
  modelId: string;
  idColumn?: string;
  numClusters?: number;
  sourceSql: string;
}): string {
  const fq = `\`${gcp.projectId}.${args.datasetId}.${args.modelId}\``;
  // The id labels rows for assignment readout, it is NOT a clustering dimension
  // — exclude it. Everything else the SELECT returns is a feature, so the tool
  // stays schema-agnostic.
  const trainingSelect = args.idColumn
    ? `SELECT * EXCEPT(\`${args.idColumn}\`) FROM (\n${args.sourceSql}\n)`
    : args.sourceSql;
  const options = [
    "model_type = 'KMEANS'",
    // Features live on wildly different scales (revenue vs. order count);
    // standardizing stops the largest-magnitude column from dominating distance.
    "standardize_features = TRUE",
    // K-means++ seeding beats random init for cluster stability/quality.
    "kmeans_init_method = 'KMEANS++'",
    // Only pin k when the caller asked; otherwise BigQuery auto-selects it.
    args.numClusters ? `num_clusters = ${args.numClusters}` : null,
  ]
    .filter(Boolean)
    .join(",\n  ");
  return `CREATE OR REPLACE MODEL ${fq}\nOPTIONS(\n  ${options}\n) AS (\n${trainingSelect}\n)`;
}

function translateClusteringError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/num_clusters|number of clusters|fewer than|at least \d+ row/i.test(msg)) {
    return new Error(
      "Not enough rows to form that many segments. Lower num_clusters, or widen source_sql to return more entities."
    );
  }
  if (/no features|feature columns|only.*label|at least one/i.test(msg)) {
    return new Error(
      "Clustering needs at least one feature column besides the id. Make source_sql return the numeric/categorical attributes to segment on."
    );
  }
  return new Error(`Model training failed: ${msg}`);
}

/** Resolve a centroid feature value: numeric mean, or the dominant category. */
function centroidValue(row: Record<string, unknown>): number | string {
  const num = row["numerical_value"];
  if (num !== null && num !== undefined) return cellNum(num);
  const cats = row["categorical_value"];
  if (Array.isArray(cats) && cats.length > 0) {
    let best: { category: string; value: number } | null = null;
    for (const c of cats as Record<string, unknown>[]) {
      const value = cellNum(c["value"]);
      if (!best || value > best.value) best = { category: cellStr(c["category"]), value };
    }
    if (best) return best.category;
  }
  return NaN;
}

export async function runClustering(spec: ClusteringSpec): Promise<ClusteringResult> {
  if (spec.idColumn) assertIdentifier(spec.idColumn, "id_column");
  if (spec.numClusters !== undefined && (spec.numClusters < 2 || spec.numClusters > 20)) {
    throw new Error("num_clusters must be between 2 and 20.");
  }
  const sourceSql = validateSourceSql(spec.sourceSql);
  const datasetId = modelsDatasetId(spec.clientId, spec.workspaceId);
  // id_column changes which columns are features and num_clusters changes the
  // trained model, so both are part of model identity. topN only affects how
  // many assignments we read back, so it's excluded — re-reads reuse the cache.
  const modelId = hashParts(
    sourceSql,
    spec.idColumn ?? "",
    String(spec.numClusters ?? ""),
    "KMEANS"
  );

  await ensureModelsDataset(datasetId, spec.location);
  const ddl = buildClustererDdl({
    datasetId,
    modelId,
    idColumn: spec.idColumn,
    numClusters: spec.numClusters,
    sourceSql,
  });
  const train = await ensureModelDdl(
    datasetId,
    modelId,
    ddl,
    spec.location,
    translateClusteringError
  );
  if (train.trained) {
    logBqmlUsage({
      eventType: "model.train",
      clientId: spec.clientId,
      workspaceId: spec.workspaceId,
      userId: spec.userId,
      resource: modelId,
      bytesScanned: train.bytesProcessed,
      executionMs: train.executionMs,
    });
  }

  const fq = `\`${gcp.projectId}.${datasetId}.${modelId}\``;
  const sizesSql =
    `SELECT CENTROID_ID AS cluster, COUNT(*) AS size ` +
    `FROM ML.PREDICT(MODEL ${fq}, (\n${sourceSql}\n)) ` +
    `GROUP BY cluster ORDER BY cluster`;
  const centroidsSql =
    `SELECT centroid_id AS cluster, feature, numerical_value, categorical_value ` +
    `FROM ML.CENTROIDS(MODEL ${fq})`;

  const wantAssign = Boolean(spec.idColumn);
  const topN = spec.topN ?? 200;

  const startedAt = Date.now();
  const jobs: Promise<JobResult>[] = [
    runQuery(sizesSql, spec.location, { maxRows: 50 }),
    runQuery(centroidsSql, spec.location, { maxRows: 5000 }),
  ];
  if (wantAssign) {
    // nearest_centroids_distance is an ARRAY<STRUCT<centroid_id, distance>>;
    // the assigned centroid's distance is the smallest one.
    const assignSql =
      `SELECT \`${spec.idColumn}\` AS id, CENTROID_ID AS cluster, ` +
      `(SELECT MIN(d.distance) FROM UNNEST(nearest_centroids_distance) AS d) AS distance ` +
      `FROM ML.PREDICT(MODEL ${fq}, (\n${sourceSql}\n)) ` +
      `ORDER BY cluster, distance LIMIT ${topN}`;
    jobs.push(runQuery(assignSql, spec.location, { maxRows: topN }));
  }

  const results = await Promise.all(jobs);
  const [sizesRes, centroidsRes] = results;
  const assignRes = wantAssign ? results[2] : undefined;

  const bytes =
    sizesRes.bytesProcessed +
    centroidsRes.bytesProcessed +
    (assignRes?.bytesProcessed ?? 0);
  logBqmlUsage({
    eventType: "cluster.run",
    clientId: spec.clientId,
    workspaceId: spec.workspaceId,
    userId: spec.userId,
    resource: modelId,
    bytesScanned: bytes,
    executionMs: Date.now() - startedAt,
  });

  const sizeByCluster = new Map<number, number>();
  for (const r of sizesRes.rows) {
    sizeByCluster.set(cellNum(r["cluster"]), cellNum(r["size"]));
  }

  const featuresByCluster = new Map<number, Record<string, number | string>>();
  for (const r of centroidsRes.rows) {
    const cluster = cellNum(r["cluster"]);
    const feat = cellStr(r["feature"]);
    const bucket = featuresByCluster.get(cluster) ?? {};
    bucket[feat] = centroidValue(r);
    featuresByCluster.set(cluster, bucket);
  }

  const profiles: ClusterProfile[] = [...featuresByCluster.keys()]
    .sort((a, b) => a - b)
    .map((cluster) => ({
      cluster,
      size: sizeByCluster.get(cluster) ?? 0,
      features: featuresByCluster.get(cluster) ?? {},
    }));

  const assignments: ClusterAssignment[] | undefined = assignRes?.rows.map((r) => ({
    id: cellStr(r["id"]),
    cluster: cellNum(r["cluster"]),
    distance: cellNum(r["distance"]),
  }));

  return {
    trained: train.trained,
    modelId,
    numClusters: profiles.length,
    profiles,
    assignments,
  };
}

// ── Recommendations (item co-occurrence / market basket) ───────────
//
// Deliberately NOT BigQuery ML MATRIX_FACTORIZATION: that model type is gated
// behind BigQuery editions/reservations and won't run on on-demand pricing,
// which the rest of this module assumes. Item-item co-occurrence gives the same
// "frequently bought together" / "customers who bought X also bought Y" answer
// with plain aggregation SQL — on-demand, no model to train, and it rides the
// same dry-run + MAX_BYTES_BILLED guard as everything else here.

/** An unordered item pair and its association strength across baskets. */
export interface ItemPair {
  itemA: string;
  itemB: string;
  /** Baskets containing both items. */
  coCount: number;
  countA: number;
  countB: number;
  /** P(B in basket | A in basket). */
  confidenceAtoB: number;
  /** P(A in basket | B in basket). */
  confidenceBtoA: number;
  /** co-occurrence vs. independence: >1 means bought together more than chance. */
  lift: number;
}

/** A single recommendation for a focused target item. */
export interface TargetRecommendation {
  item: string;
  coCount: number;
  /** P(item | target) — how often target buyers also took this. */
  confidence: number;
  lift: number;
}

export interface RecommendationResult {
  basketsAnalyzed: number;
  /** Top item pairs overall. Present when no target_item was supplied. */
  pairs?: ItemPair[];
  /** The focused item, when target_item was supplied. */
  target?: string;
  /** Items most associated with `target`. Present when target_item was supplied. */
  recommendations?: TargetRecommendation[];
}

export interface RecommendationSpec {
  clientId: string;
  workspaceId: string;
  userId?: string;
  /** Agent-authored SELECT: one row per (basket, item) — e.g. order line items,
   * or one row per (customer, product) purchase. */
  sourceSql: string;
  /** The basket key: an order id (items bought together) or a customer id
   * (items bought by the same person). Co-occurrence is computed within it. */
  groupColumn: string;
  /** The item identifier column to recommend on. */
  itemColumn: string;
  /** Focus recommendations on items associated with this one item. */
  targetItem?: string;
  /** Ignore pairs seen in fewer than this many baskets (noise floor). Default 5. */
  minSupport?: number;
  /** Max rows to return. Default 50. */
  topN?: number;
  /** Workspace BQ residency: "EU" | "US". */
  location: string;
}

export async function runRecommendations(
  spec: RecommendationSpec
): Promise<RecommendationResult> {
  assertIdentifier(spec.groupColumn, "group_column");
  assertIdentifier(spec.itemColumn, "item_column");
  const sourceSql = validateSourceSql(spec.sourceSql);
  // minSupport/topN are ours to control → safe to inline as integers.
  const minSupport = Math.max(1, Math.floor(spec.minSupport ?? 5));
  const topN = Math.max(1, Math.min(1000, Math.floor(spec.topN ?? 50)));
  const g = spec.groupColumn;
  const i = spec.itemColumn;

  // DISTINCT (basket, item) so a repeated item in one basket counts once. CAST
  // to STRING for stable comparison/output regardless of the column's type.
  const baskets =
    `b AS (\n` +
    `  SELECT DISTINCT CAST(\`${g}\` AS STRING) AS g, CAST(\`${i}\` AS STRING) AS i\n` +
    `  FROM (\n${sourceSql}\n)\n` +
    `  WHERE \`${g}\` IS NOT NULL AND \`${i}\` IS NOT NULL\n` +
    `),\n` +
    `ic AS (SELECT i, COUNT(*) AS cnt FROM b GROUP BY i),\n` +
    `tot AS (SELECT COUNT(DISTINCT g) AS n FROM b)`;

  const wantTarget = Boolean(spec.targetItem);
  let sql: string;
  if (wantTarget) {
    // target_item is arbitrary user data → bind as @target, never interpolate.
    sql =
      `WITH ${baskets},\n` +
      `tcount AS (SELECT cnt FROM ic WHERE i = @target),\n` +
      `co AS (\n` +
      `  SELECT y.i AS item, COUNT(*) AS co\n` +
      `  FROM b x JOIN b y ON x.g = y.g AND x.i = @target AND y.i != @target\n` +
      `  GROUP BY item\n` +
      `)\n` +
      `SELECT co.item AS item, co.co AS co_count, ic.cnt AS count_item,\n` +
      `  (SELECT cnt FROM tcount) AS count_target, tot.n AS total_baskets,\n` +
      `  SAFE_DIVIDE(co.co, (SELECT cnt FROM tcount)) AS confidence,\n` +
      `  SAFE_DIVIDE(co.co * tot.n, (SELECT cnt FROM tcount) * ic.cnt) AS lift\n` +
      `FROM co JOIN ic ON co.item = ic.i CROSS JOIN tot\n` +
      `WHERE co.co >= ${minSupport}\n` +
      `ORDER BY lift DESC, co_count DESC LIMIT ${topN}`;
  } else {
    sql =
      `WITH ${baskets},\n` +
      `pairs AS (\n` +
      `  SELECT x.i AS a, y.i AS b_item, COUNT(*) AS co\n` +
      `  FROM b x JOIN b y ON x.g = y.g AND x.i < y.i\n` +
      `  GROUP BY a, b_item\n` +
      `)\n` +
      `SELECT p.a AS item_a, p.b_item AS item_b, p.co AS co_count,\n` +
      `  ca.cnt AS count_a, cb.cnt AS count_b, tot.n AS total_baskets,\n` +
      `  SAFE_DIVIDE(p.co, ca.cnt) AS conf_a_b,\n` +
      `  SAFE_DIVIDE(p.co, cb.cnt) AS conf_b_a,\n` +
      `  SAFE_DIVIDE(p.co * tot.n, ca.cnt * cb.cnt) AS lift\n` +
      `FROM pairs p JOIN ic ca ON p.a = ca.i JOIN ic cb ON p.b_item = cb.i CROSS JOIN tot\n` +
      `WHERE p.co >= ${minSupport}\n` +
      `ORDER BY lift DESC, co_count DESC LIMIT ${topN}`;
  }

  const startedAt = Date.now();
  const res = await runQuery(sql, spec.location, {
    dryRunFirst: true,
    maxRows: topN,
    ...(wantTarget ? { params: { target: spec.targetItem } } : {}),
  });

  logBqmlUsage({
    eventType: "recommend.run",
    clientId: spec.clientId,
    workspaceId: spec.workspaceId,
    userId: spec.userId,
    resource: hashParts(sourceSql, g, i, spec.targetItem ?? "", "RECOMMEND"),
    bytesScanned: res.bytesProcessed,
    executionMs: Date.now() - startedAt,
  });

  const basketsAnalyzed = res.rows.length > 0 ? cellNum(res.rows[0]["total_baskets"]) : 0;

  if (wantTarget) {
    const recommendations: TargetRecommendation[] = res.rows.map((r) => ({
      item: cellStr(r["item"]),
      coCount: cellNum(r["co_count"]),
      confidence: cellNum(r["confidence"]),
      lift: cellNum(r["lift"]),
    }));
    return { basketsAnalyzed, target: spec.targetItem, recommendations };
  }

  const pairs: ItemPair[] = res.rows.map((r) => ({
    itemA: cellStr(r["item_a"]),
    itemB: cellStr(r["item_b"]),
    coCount: cellNum(r["co_count"]),
    countA: cellNum(r["count_a"]),
    countB: cellNum(r["count_b"]),
    confidenceAtoB: cellNum(r["conf_a_b"]),
    confidenceBtoA: cellNum(r["conf_b_a"]),
    lift: cellNum(r["lift"]),
  }));
  return { basketsAnalyzed, pairs };
}
