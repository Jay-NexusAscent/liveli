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
 * Iterates all connectors in the workspace, opens their dataset,
 * returns flat list with `dataset.table` keys.
 *
 * Replaces the old single-dataset listWorkspaceTables(orgId) which
 * assumed one shared dataset per workspace.
 */
export async function listWorkspaceTables(
  clientId: string,
  workspaceId: string,
  connectorIds: { id: string; name?: string; type?: string }[]
): Promise<WorkspaceTable[]> {
  const client = await bqReady();
  const out: WorkspaceTable[] = [];

  for (const conn of connectorIds) {
    const datasetId = connectorDatasetId(clientId, workspaceId, conn.id);
    const [exists] = await client.dataset(datasetId).exists();
    if (!exists) continue;

    const [tables] = await client.dataset(datasetId).getTables();
    for (const t of tables) {
      const [meta] = await t.getMetadata();
      out.push({
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
      });
    }
  }

  return out;
}
