import { BigQuery } from "@google-cloud/bigquery";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _bq: BigQuery | null = null;

/**
 * Workspace BigQuery datasets are in **US** multi-region for the demo so
 * federated views over `bigquery-public-data.*` (which lives in US) work
 * without cross-region copy. The agent-metadata dataset declared in
 * Terraform stays in EU because that's app-managed metadata, not customer
 * data. When per-workspace region selection lands (data-residency feature
 * in Linear), this becomes per-workspace config.
 */
export const WORKSPACE_BQ_LOCATION = "US";

export function bq(): BigQuery {
  if (_bq) return _bq;
  _bq = new BigQuery({ projectId: gcp.projectId, location: WORKSPACE_BQ_LOCATION });
  return _bq;
}

export async function bqReady() {
  await ensureGcpAuth();
  return bq();
}

/**
 * Workspace datasets live as `ws_<orgIdSlug>` so each tenant is isolated.
 * BigQuery dataset IDs must be alphanumeric+underscore — slugify the orgId.
 */
export function workspaceDatasetId(orgId: string): string {
  return `ws_${orgId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`;
}

export interface SafeQueryOptions {
  /** Hard cap on bytes scanned. Default 10 GB. */
  maxBytesBilled?: number;
  /** Hard cap on rows returned. Default 1000. */
  maxRows?: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  bytesScanned: number;
  truncated: boolean;
}

/**
 * Run a query against the workspace dataset with safety caps. Dry-runs first
 * to estimate cost; rejects if estimated bytes scanned exceeds maxBytesBilled.
 */
export async function safeQuery(
  orgId: string,
  sql: string,
  opts: SafeQueryOptions = {}
): Promise<QueryResult> {
  const maxBytesBilled = opts.maxBytesBilled ?? 10 * 1024 * 1024 * 1024; // 10 GB
  const maxRows = opts.maxRows ?? 1000;

  const client = await bqReady();
  const datasetId = workspaceDatasetId(orgId);

  // Dry-run cost estimate.
  const [dry] = await client.createQueryJob({
    query: sql,
    location: WORKSPACE_BQ_LOCATION,
    defaultDataset: { datasetId, projectId: gcp.projectId },
    dryRun: true,
  });
  const estimatedBytes = Number(dry.metadata.statistics?.totalBytesProcessed ?? 0);
  if (estimatedBytes > maxBytesBilled) {
    throw new Error(
      `Query would scan ${(estimatedBytes / 1e9).toFixed(2)} GB (limit ${(maxBytesBilled / 1e9).toFixed(0)} GB). Refine your query.`
    );
  }

  // Real run.
  const [job] = await client.createQueryJob({
    query: sql,
    location: WORKSPACE_BQ_LOCATION,
    defaultDataset: { datasetId, projectId: gcp.projectId },
    maximumBytesBilled: String(maxBytesBilled),
  });
  const [rows] = await job.getQueryResults({ maxResults: maxRows });
  const [meta] = await job.getMetadata();

  return {
    rows: rows as Record<string, unknown>[],
    rowCount: rows.length,
    bytesScanned: Number(meta.statistics?.totalBytesProcessed ?? 0),
    truncated: rows.length >= maxRows,
  };
}

/**
 * INFORMATION_SCHEMA-backed list of tables in the workspace dataset, with
 * column types. Used by the agent's list_tables tool.
 */
export async function listWorkspaceTables(orgId: string) {
  const client = await bqReady();
  const datasetId = workspaceDatasetId(orgId);
  const [exists] = await client.dataset(datasetId).exists();
  if (!exists) return [];

  const [tables] = await client.dataset(datasetId).getTables();
  return Promise.all(
    tables.map(async (t) => {
      const [meta] = await t.getMetadata();
      return {
        name: t.id ?? "",
        rowCount: Number(meta.numRows ?? 0),
        columns:
          (meta.schema?.fields ?? []).map((f: { name: string; type: string }) => ({
            name: f.name,
            type: f.type,
          })) ?? [],
      };
    })
  );
}
