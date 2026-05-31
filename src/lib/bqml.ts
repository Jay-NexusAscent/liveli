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
  opts: { dryRunFirst?: boolean; maxRows?: number } = {}
): Promise<JobResult> {
  const client = await bqReady();

  if (opts.dryRunFirst) {
    const [dry] = await client.createQueryJob({ query: sql, location, dryRun: true });
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
  });
  const [rows] = await job.getQueryResults({ maxResults: opts.maxRows ?? 5000 });
  const [meta] = await job.getMetadata();
  const bytesProcessed = Number(meta.statistics?.totalBytesProcessed ?? 0);
  return { rows: rows as Record<string, unknown>[], bytesProcessed };
}

// ── Model lifecycle ────────────────────────────────────────────────

function fingerprint(spec: {
  sourceSql: string;
  timeColumn: string;
  valueColumn: string;
  seriesColumn?: string;
  dataFrequency: string;
  holidayRegion?: string;
}): string {
  const normalized = spec.sourceSql.replace(/\s+/g, " ").trim();
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        normalized,
        spec.timeColumn,
        spec.valueColumn,
        spec.seriesColumn ?? "",
        spec.dataFrequency,
        spec.holidayRegion ?? "",
      ])
    )
    .digest("hex")
    .slice(0, 16);
  return `m_${hash}`;
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

/** Train the model if missing or stale; otherwise reuse the cached one. */
async function ensureModel(
  datasetId: string,
  modelId: string,
  spec: Omit<SeriesSpec, "dataFrequency"> & { dataFrequency: string }
): Promise<{ trained: boolean; bytesProcessed: number; executionMs: number }> {
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

  const startedAt = Date.now();
  let result: JobResult;
  try {
    result = await runQuery(ddl, spec.location, { dryRunFirst: true, maxRows: 0 });
  } catch (err) {
    throw translateTrainingError(err);
  }
  return {
    trained: true,
    bytesProcessed: result.bytesProcessed,
    executionMs: Date.now() - startedAt,
  };
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
