import { BigQuery } from "@google-cloud/bigquery";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";
import { logQueryRun } from "@/lib/usage";

let _bq: BigQuery | null = null;

/**
 * Default BigQuery location for new workspaces. EU multi-region is the
 * right default — GDPR-friendly, low latency for UK/EU customers.
 *
 * Per-workspace overrides live on the WorkspaceDoc.bqLocation field
 * (Firestore). When provisioning new datasets, callers SHOULD pass the
 * workspace's configured location rather than relying on this default.
 *
 * Older code referenced "US" — that was a demo-time compromise to make
 * federated views over bigquery-public-data work. With the demo path
 * removed, we default to EU. Workspaces created during the US-default
 * era keep their US location for the lifetime of the workspace (BQ
 * datasets are immutable region-wise).
 */
export const DEFAULT_BQ_LOCATION = "EU";

/**
 * @deprecated Use the per-workspace `bqLocation` field on the workspace
 * doc instead. Kept while callsites are migrated.
 */
export const WORKSPACE_BQ_LOCATION = DEFAULT_BQ_LOCATION;

export function bq(): BigQuery {
  if (_bq) return _bq;
  // location is set per-query/dataset, not on the client.
  _bq = new BigQuery({ projectId: gcp.projectId });
  return _bq;
}

export async function bqReady() {
  await ensureGcpAuth();
  return bq();
}

// ── Dataset naming ─────────────────────────────────────────────────
//
//   c_<clientIdSlug>__w_<workspaceIdSlug>__d_<connectorIdSlug>
//
// Each segment:
//   c_    — namespace marker for customer datasets (vs liveli_internal)
//   __w_  — workspace boundary
//   __d_  — datasource (connector) boundary
//
// IDs are slugified — lowercased + non-alphanum replaced with underscore
// — because BQ dataset IDs are restricted to alphanumeric + underscore.
// We use the full IDs (not prefixes) to guarantee uniqueness; total
// length stays well under BQ's 1024-char limit (~80 chars in practice).

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

/**
 * Build the canonical dataset name for one (client, workspace, connector)
 * tuple. Pure function; doesn't touch BQ.
 */
export function connectorDatasetId(
  clientId: string,
  workspaceId: string,
  connectorId: string
): string {
  return `c_${slug(clientId)}__w_${slug(workspaceId)}__d_${slug(connectorId)}`;
}

/**
 * @deprecated Old per-workspace shared dataset name. Used by routes
 * not yet migrated to dataset-per-connector. Will be removed once all
 * connector flows use connectorDatasetId().
 */
export function workspaceDatasetId(orgId: string): string {
  return `ws_${slug(orgId)}`;
}

// ── Staging table cleanup ──────────────────────────────────────────
//
// z3z1ma/target-bigquery in batch_job mode writes incoming rows to a
// staging table named `<stream>__<YYYYMMDDHHMMSS>__<uuid-v4>`, then
// (in upsert/overwrite mode) merges or swaps it into the canonical
// table and drops the staging. When the post-load step fails for any
// reason — MERGE silently dies on a no-PK table, type mismatch on
// overwrite, network blip mid-operation — the staging table is left
// behind. Symptom: dataset accumulates dozens of `<table>__<ts>__<uuid>`
// over time; the agent's list_tables tool sees them all as siblings
// of the canonical and gets confused about which holds the real data.
//
// Pattern matches z3z1ma's exact naming: double-underscore, 14-digit
// timestamp, double-underscore, RFC 4122 UUID. Tight enough to not
// collide with any reasonable user table name a tap might emit.
export const STAGING_TABLE_PATTERN =
  /__\d{14}__[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStagingTable(tableId: string): boolean {
  return STAGING_TABLE_PATTERN.test(tableId);
}

/**
 * Drop staging tables in a connector's dataset that are older than the
 * threshold. Best-effort: errors are logged, never thrown — cleanup
 * failure must not block a sync.
 *
 * Safety: only drops tables matching the STAGING_TABLE_PATTERN. Only
 * drops tables CREATED before `cutoffMs` ago (default 1h, longer than
 * the Cloud Run Job's 30-min max timeout — guarantees we never drop
 * staging belonging to a concurrent in-flight execution).
 *
 * Called from sync/route.ts + scheduled-sync/route.ts BEFORE triggering
 * the next Cloud Run Job. Running pre-sync (rather than post-sync via
 * a Pub/Sub webhook) is intentional: no completion hook to wire, no
 * new infra, eventual consistency — orphans from run N get dropped at
 * the start of run N+1.
 */
export async function cleanupStaleStagingTables(
  datasetId: string,
  opts: { thresholdMs?: number } = {}
): Promise<{ dropped: number; checked: number }> {
  const thresholdMs = opts.thresholdMs ?? 60 * 60 * 1000; // 1h default
  const cutoff = Date.now() - thresholdMs;

  let dropped = 0;
  let checked = 0;
  try {
    const client = await bqReady();
    const [tables] = await client.dataset(datasetId).getTables();
    for (const t of tables) {
      checked++;
      const tableId = t.id ?? "";
      if (!isStagingTable(tableId)) continue;
      // Metadata lookup gets creationTime. We could parse the timestamp
      // out of the staging table name itself (it's right there as YYYY-
      // MMDDHHMMSS), but using BQ's authoritative creationTime is safer
      // against clock skew / future renames.
      try {
        const [meta] = await t.getMetadata();
        const createdMs = Number(meta.creationTime ?? 0);
        if (createdMs && createdMs >= cutoff) continue; // too young to drop
        await t.delete();
        dropped++;
      } catch (err) {
        console.warn("[bq] staging-table cleanup: skip", {
          datasetId,
          tableId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    console.warn("[bq] staging-table cleanup: dataset enumeration failed", {
      datasetId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  if (dropped > 0) {
    console.log("[bq] staging-table cleanup", { datasetId, dropped, checked });
  }
  return { dropped, checked };
}

// ── Safe query ─────────────────────────────────────────────────────

export interface SafeQueryOptions {
  /** Hard cap on bytes scanned. Default 10 GB. */
  maxBytesBilled?: number;
  /** Hard cap on rows returned. Default 1000. */
  maxRows?: number;
  /** Workspace's BQ location (EU/US). Defaults to EU. */
  location?: string;
  /** clientId / workspaceId labels for cost attribution + usage tracking. */
  context?: {
    clientId: string;
    workspaceId: string;
    userId?: string;
    connectorId?: string;
  };
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  bytesScanned: number;
  truncated: boolean;
}

/**
 * Run a query against BigQuery with safety caps + cost attribution.
 *
 * - Dry-runs first to estimate cost; rejects if estimated bytes scanned
 *   exceeds maxBytesBilled.
 * - Sets labels {customer, workspace, connector} on the job so Cloud
 *   Billing Export attributes the cost correctly.
 * - Logs to liveli_internal.usage_events for in-app billing UI.
 *
 * IMPORTANT: this no longer sets a defaultDataset. In the new
 * dataset-per-connector model the agent writes fully-qualified table
 * names (`<dataset>.<table>`) and inferring a default would lead to
 * the agent silently querying the wrong connector's data.
 */
export async function safeQuery(
  sql: string,
  opts: SafeQueryOptions = {}
): Promise<QueryResult> {
  const maxBytesBilled = opts.maxBytesBilled ?? 10 * 1024 * 1024 * 1024; // 10 GB
  const maxRows = opts.maxRows ?? 1000;
  const location = opts.location ?? DEFAULT_BQ_LOCATION;

  const client = await bqReady();

  const labels: Record<string, string> = {};
  if (opts.context?.clientId) labels.customer = slug(opts.context.clientId);
  if (opts.context?.workspaceId) labels.workspace = slug(opts.context.workspaceId);
  if (opts.context?.connectorId) labels.connector = slug(opts.context.connectorId);

  // Dry-run cost estimate.
  const [dry] = await client.createQueryJob({
    query: sql,
    location,
    dryRun: true,
    labels,
  });
  const estimatedBytes = Number(dry.metadata.statistics?.totalBytesProcessed ?? 0);
  if (estimatedBytes > maxBytesBilled) {
    throw new Error(
      `Query would scan ${(estimatedBytes / 1e9).toFixed(2)} GB (limit ${(maxBytesBilled / 1e9).toFixed(0)} GB). Refine your query.`
    );
  }

  // Real run.
  const startedAt = Date.now();
  const [job] = await client.createQueryJob({
    query: sql,
    location,
    maximumBytesBilled: String(maxBytesBilled),
    labels,
  });
  const [rawRows] = await job.getQueryResults({ maxResults: maxRows });
  const rows = rawRows.map((r) => sanitizeBqRow(r as Record<string, unknown>));
  const [meta] = await job.getMetadata();
  const bytesScanned = Number(meta.statistics?.totalBytesProcessed ?? 0);

  // Async — never block on logging.
  if (opts.context) {
    logQueryRun({
      clientId: opts.context.clientId,
      workspaceId: opts.context.workspaceId,
      userId: opts.context.userId,
      connectorId: opts.context.connectorId,
      bytesScanned,
      executionMs: Date.now() - startedAt,
    });
  }

  return {
    rows,
    rowCount: rows.length,
    bytesScanned,
    truncated: rows.length >= maxRows,
  };
}

/**
 * Normalize a BigQuery row so every value is a plain JSON-serializable
 * primitive / array / object.
 *
 * Why: BigQuery's Node SDK returns TIMESTAMP/DATE/DATETIME/TIME/NUMERIC
 * columns as instances of its own classes (BigQueryTimestamp,
 * BigQueryDate, etc.) — each carries a `.value` string with the
 * canonical representation. These class instances JSON-serialize fine
 * (via toJSON), but Firestore's Node SDK value serializer rejects them
 * because they're objects with custom prototypes. Since we persist
 * tool_result content (which includes SQL rows) to Firestore for chat
 * history, every row must be POJO-clean at the moment it leaves this
 * module.
 *
 * STRUCT columns come back as nested objects (recurse). ARRAY columns
 * come back as JS arrays (recurse). Everything else passes through.
 */
function sanitizeBqRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = sanitizeBqValue(v);
  }
  return out;
}

function sanitizeBqValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sanitizeBqValue);
  if (v instanceof Date) return v.toISOString();
  // BigQueryTimestamp / Date / Datetime / Time / Numeric / BigNumeric /
  // Geography all expose a `.value` string. Buffer (for BYTES) does not —
  // it'd fall through to the recursion below; we don't currently surface
  // BYTES columns so leaving Buffers as-is is fine.
  const maybe = v as { value?: unknown };
  if (typeof maybe.value === "string") return maybe.value;
  // Plain or STRUCT — recurse.
  const out: Record<string, unknown> = {};
  for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
    out[k] = sanitizeBqValue(vv);
  }
  return out;
}

// ── Listing tables across all of a workspace's connector datasets ──

export interface WorkspaceTable {
  /** Fully qualified `<dataset>.<table>` for use in agent SQL. */
  qualifiedName: string;
  /** Dataset that backs this table (one dataset per connector). */
  dataset: string;
  /** Just the table portion of the qualified name. */
  table: string;
  /** Friendly connector name (for UI display + agent context). */
  connectorName?: string;
  /** Connector type (postgres, stripe, etc.). */
  connectorType?: string;
  rowCount: number;
  columns: { name: string; type: string }[];
}

/**
 * List every table the agent can see for a (clientId, workspaceId).
 * Iterates all connectors, opens each dataset, returns flat list with
 * `dataset.table` keys.
 *
 * Performance: every BQ round-trip (dataset.getTables + per-table
 * getMetadata) runs in parallel via Promise.all. With N connectors and
 * M tables-per-connector, the serial version was O(N + N*M) sequential
 * round-trips — easily 30-50s for an 8-connector / 5-tables-each
 * workspace and would hit the chat route's 60s maxDuration. Parallel
 * version is O(max round-trip time) ≈ a few seconds regardless of
 * connector count.
 *
 * No `dataset.exists()` precheck — we just call getTables() and treat
 * a NOT_FOUND error as "no tables yet" (e.g. a connector that hasn't
 * had its first sync). Saves one round-trip per connector and is
 * idempotent vs. the explicit exists call.
 */
/**
 * Singer/Meltano target-bigquery writes each sync to a versioned
 * staging table named `<canonical>__<14-digit-timestamp>__<uuid>` and
 * (currently) doesn't promote into the canonical table. The result is
 * a dataset with one canonical table + N stale staging copies, growing
 * every sync.
 *
 * For the agent's purposes, only the canonical table is a meaningful
 * surface — the staging copies are an ingestion artifact, not user
 * data. We filter them out here so list_tables returns a clean list.
 *
 * ⚠️ Known follow-up: when the canonical table never receives the
 * loaded rows (sync misconfiguration), the customer's real data ends
 * up stranded in the staging copies that this filter now hides. The
 * fix is on the loader side — target-bigquery needs to be configured
 * to APPEND or MERGE into the canonical, not just write staging. See
 * the new Linear ticket on sync data promotion.
 */
// Note: STAGING_TABLE_PATTERN + isStagingTable are defined at the top of
// this file (alongside cleanupStaleStagingTables). A locally-scoped
// duplicate was added here in a separate PR — consolidated on the
// exported version so there's a single source of truth for the pattern.

export async function listWorkspaceTables(
  clientId: string,
  workspaceId: string,
  connectorIds: { id: string; name?: string; type?: string }[]
): Promise<WorkspaceTable[]> {
  const client = await bqReady();
  const startedAt = Date.now();

  const perConnector = await Promise.all(
    connectorIds.map(async (conn) => {
      const datasetId = connectorDatasetId(clientId, workspaceId, conn.id);
      let tables;
      try {
        [tables] = await client.dataset(datasetId).getTables();
      } catch (err) {
        const code = (err as { code?: number }).code;
        // 404 = dataset doesn't exist (connector hasn't synced yet).
        // Anything else, surface so we don't silently hide real BQ errors.
        if (code === 404) return [] as WorkspaceTable[];
        throw err;
      }
      // Filter out z3z1ma target-bigquery staging tables before the agent
      // ever sees them. Even with the post-sync `cleanupStaleStagingTables`
      // sweep there's a window — between a Cloud Run Job creating staging
      // and the next sync's cleanup — where orphans exist in the dataset.
      // The agent should not be choosing between `public_orders` and 80
      // siblings called `public_orders__YYYYMMDDHHMMSS__<uuid>`; surface
      // only the canonical names. Bonus: filtering BEFORE the per-table
      // getMetadata round-trip saves one BQ call per excluded staging.
      const filteredTables = tables.filter((t) => !isStagingTable(t.id ?? ""));
      const rows = await Promise.all(
        filteredTables.map(async (t) => {
          const [meta] = await t.getMetadata();
          return {
            qualifiedName: `${datasetId}.${t.id ?? ""}`,
            dataset: datasetId,
            table: t.id ?? "",
            connectorName: conn.name,
            connectorType: conn.type,
            rowCount: Number(meta.numRows ?? 0),
            columns: (meta.schema?.fields ?? []).map(
              (f: { name: string; type: string }) => ({
                name: f.name,
                type: f.type,
              })
            ),
          } satisfies WorkspaceTable;
        })
      );
      return rows;
    })
  );

  const out = perConnector.flat();
  console.log("[listWorkspaceTables] done", {
    clientId,
    workspaceId,
    connectorCount: connectorIds.length,
    tableCount: out.length,
    durationMs: Date.now() - startedAt,
  });
  return out;
}
