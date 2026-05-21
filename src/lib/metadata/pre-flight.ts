import { bqReady, safeQuery } from "@/lib/bigquery";
import { assertDatasetMatchesConnector } from "./dataset-isolation";

/**
 * Singer/Meltano writes versioned staging copies of every table named
 * `<canonical>__<14-digit-timestamp>__<uuid>`. They're an ingestion
 * artifact, not customer data — listWorkspaceTables() already hides
 * them from the chat agent, and the metadata gate must hide them too
 * so we don't waste enrichment cycles on tables that won't survive
 * the next sync.
 *
 * Pattern kept in sync with bigquery.ts:STAGING_TABLE_SUFFIX.
 */
const STAGING_TABLE_SUFFIX =
  /__\d{14}__[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isStagingTableName(tableId: string): boolean {
  return STAGING_TABLE_SUFFIX.test(tableId);
}

/**
 * Singer/Meltano injects sync-metadata columns prefixed `_sdc_`
 * (`_sdc_extracted_at`, `_sdc_batched_at`, etc.) into every loaded
 * table. The chat agent's run_sql tool already strips them at query
 * time; we exclude them from enrichment too — describing ingestion
 * plumbing isn't useful to a downstream consumer.
 */
function isSingerInternalColumn(fieldPath: string): boolean {
  return fieldPath.startsWith("_sdc_");
}

export interface UncoveredColumn {
  table: string;
  /**
   * BigQuery COLUMN_FIELD_PATHS exposes one row per leaf field. For
   * scalar columns this is just the column name; for STRUCT columns
   * it's the dotted path (e.g. `address.postcode`).
   */
  fieldPath: string;
}

export interface UncoveredMetadata {
  /** Tables whose top-level description is empty or unset. */
  tables: string[];
  /** Column field paths whose description is empty or unset. */
  columns: UncoveredColumn[];
}

export interface PreFlightInput {
  clientId: string;
  workspaceId: string;
  connectorId: string;
  bqDataset: string;
  bqLocation: string;
}

/**
 * Cheap pre-flight gate: returns the exact set of tables and columns
 * inside `bqDataset` that are missing a description.
 *
 * Cost profile:
 *   - One INFORMATION_SCHEMA.COLUMN_FIELD_PATHS query (metadata-only,
 *     does not scan user data; safeQuery's dryRun confirms ~0 bytes).
 *   - One dataset.getTables() + parallel getMetadata() per table for
 *     table-level descriptions (BQ Tables API is metadata-only).
 *
 * Returns `{ tables: [], columns: [] }` when everything is already
 * described — the caller uses that as the "skip enrichment entirely"
 * signal, so steady-state recurring syncs don't trigger any agent work.
 *
 * Tenancy: asserts the dataset name matches the (clientId, workspaceId,
 * connectorId) tuple before issuing any query. INFORMATION_SCHEMA is
 * dataset-local by design — `<dataset>.INFORMATION_SCHEMA.X` cannot
 * surface another tenant's metadata — but we verify the name anyway.
 */
export async function findUncoveredMetadata(
  input: PreFlightInput,
): Promise<UncoveredMetadata> {
  assertDatasetMatchesConnector(
    input.bqDataset,
    input.clientId,
    input.workspaceId,
    input.connectorId,
  );

  const ctx = {
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    connectorId: input.connectorId,
  };

  // ── Column-level gate ───────────────────────────────────────────
  // One query covers every column across every table in the dataset,
  // including STRUCT leaf paths. Cheaper than N per-table getMetadata
  // calls when N is large, and INFORMATION_SCHEMA returns precise
  // null/empty distinctions that the Tables API doesn't always preserve.
  const columnResult = await safeQuery(
    `
    SELECT table_name, field_path, description
    FROM \`${input.bqDataset}\`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS
    WHERE description IS NULL OR description = ''
    ORDER BY table_name, field_path
    `,
    { location: input.bqLocation, context: ctx, maxRows: 5000 },
  );

  const columns: UncoveredColumn[] = (
    columnResult.rows as { table_name: string; field_path: string }[]
  )
    .filter((r) => !isStagingTableName(r.table_name))
    .filter((r) => !isSingerInternalColumn(r.field_path))
    .map((r) => ({ table: r.table_name, fieldPath: r.field_path }));

  // ── Table-level gate ────────────────────────────────────────────
  // We use the Tables API rather than INFORMATION_SCHEMA.TABLE_OPTIONS
  // for table descriptions: TABLE_OPTIONS stores the description as a
  // quoted SQL literal (the empty case is sometimes a missing row,
  // sometimes the string `""`), which is brittle to parse. The Tables
  // API returns `metadata.description` as a plain string and treats
  // missing/empty uniformly.
  const client = await bqReady();
  let bqTables;
  try {
    [bqTables] = await client.dataset(input.bqDataset).getTables();
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) {
      // Dataset doesn't exist — connector synced but produced no tables.
      // Nothing to enrich, nothing to skip on.
      return { tables: [], columns: [] };
    }
    throw err;
  }

  const filteredTables = bqTables.filter(
    (t) => !isStagingTableName(t.id ?? ""),
  );
  const tableDescriptions = await Promise.all(
    filteredTables.map(async (t) => {
      const [meta] = await t.getMetadata();
      return {
        tableId: t.id ?? "",
        description: typeof meta.description === "string" ? meta.description : "",
      };
    }),
  );
  const tables = tableDescriptions
    .filter((t) => t.tableId && t.description.trim() === "")
    .map((t) => t.tableId);

  return { tables, columns };
}
