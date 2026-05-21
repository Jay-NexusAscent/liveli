import { Client } from "pg";

/**
 * Detect replication strategy per table at postgres-connect time.
 *
 * Called from the postgres connect route after creds are validated by
 * Zod and BEFORE we commit anything to BQ/Secret Manager/Firestore.
 * Doubles as a creds liveness check — if `pg.connect()` fails, the
 * user finds out at the wizard, not 15 minutes later when their first
 * sync errors silently.
 *
 * The output drives two things:
 *   1. Per-stream Meltano `metadata` config injected at sync time via
 *      runtime YAML mutation in the connector's entrypoint.sh.
 *   2. UI display in the connector card / edit modal: "Incremental,
 *      keyed by updated_at" so the user can see what we picked and
 *      override if the choice is wrong.
 *
 * Detection algorithm — preference order for replication key:
 *   1. Standard "updated_at"-family timestamp columns (case-insensitive
 *      match against a hard-coded list of well-known names). Captures
 *      both inserts AND updates → most useful.
 *   2. Single-column integer PK (id, sequence) — captures inserts only,
 *      misses updates to existing rows. Better than full extracts;
 *      worse than a real updated_at. Flagged in rationale so the UI
 *      can hint at the limitation.
 *   3. None of the above → FULL_TABLE. The table will sync wholesale
 *      every time. Customer can override in the UI later.
 *
 * Out of scope here:
 *   - LOG_BASED (Postgres logical replication) — requires customer to
 *     configure wal_level + grant REPLICATION on source. Power-user
 *     mode, separate Linear ticket.
 *   - Composite PKs as replication keys — Meltano supports a single
 *     replication-key only. We FALL BACK to FULL_TABLE for these
 *     rather than picking one PK column arbitrarily.
 *   - Custom column names beyond the preference list. Manual override
 *     UI handles these (separate PR).
 */

// Replication-key column-name preference order, in two tiers.
//
// TIER 1 — "update-aware" timestamps. These columns advance whenever
// the row mutates (the app updates the column on every write). Using
// one as the replication key means incremental sync captures BOTH
// inserts AND updates: when a row in source changes, its updated_at
// advances, the sync sees `WHERE updated_at > bookmark`, and the row
// re-flows to BQ. This is the correct semantic for tables that mutate.
//
// TIER 2 — "insert-only" timestamps. These are set when the row is
// created and do NOT change afterwards (created_at, placed_at,
// signup_date, started_at, etc.). They make a fine replication key
// for tables that are genuinely insert-only (sessions, audit_log,
// events). BUT — and this is the gotcha — if the source app DOES
// update existing rows but doesn't have an `updated_at` column,
// picking an insert-only key here will SILENTLY MISS those updates
// in the agent's view of the data. The rationale field warns about
// this explicitly so the customer can see what they're getting.
//
// First match within each tier wins. We exhaust TIER 1 before
// considering TIER 2.
const UPDATE_AWARE_TIMESTAMP_KEYS = [
  "updated_at",
  "modified_at",
  "last_modified",
  "last_modified_at",
  "last_updated",
  "last_updated_at",
  "last_changed",
  "updated_dt",
  "mod_dt",
];

const INSERT_ONLY_TIMESTAMP_KEYS = [
  // Generic "this row was created at" — most common fallback
  "created_at",
  "create_dt",
  // Order / event lifecycle
  "placed_at",
  "started_at",
  "occurred_at",
  "happened_at",
  "event_at",
  // Logistics / state-change anchors. These ARE update-aware in spirit
  // (they advance when the entity transitions through a state) but
  // they don't advance on EVERY mutation — only on the specific
  // transition that sets them. Still better than picking the PK.
  "shipped_at",
  "delivered_at",
  "processed_at",
  "requested_at",
  "completed_at",
  // Customer / subscription
  "signup_date",
  "registered_at",
];

// Postgres timestamp-ish data types we'll accept as a replication key.
// `data_type` from information_schema returns the canonical lower-case
// SQL standard name (e.g. "timestamp with time zone", not "timestamptz").
const TIMESTAMP_DATA_TYPES = new Set([
  "timestamp without time zone",
  "timestamp with time zone",
  "date",
]);

// Integer types acceptable as an insert-only replication key (single-column PK).
const INTEGER_DATA_TYPES = new Set([
  "integer",
  "bigint",
  "smallint",
]);

export interface PostgresConnectionParams {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Whether to require SSL. Currently always true for managed providers. */
  ssl?: boolean;
  /** Schemas to introspect — typically ["public"]. Comma-separated input is split upstream. */
  schemas: string[];
}

export type StreamReplicationConfig = {
  "replication-method": "INCREMENTAL" | "FULL_TABLE";
  "replication-key"?: string;
};

export interface ReplicationConfig {
  /**
   * Per-stream Meltano metadata overrides. Stream key naming follows
   * meltanolabs-tap-postgres convention: `<schema>-<table>` (dashes,
   * not dots). This is what gets injected into meltano.yml's
   * extractor `metadata:` block at sync time.
   */
  streams: Record<string, StreamReplicationConfig>;
  /**
   * Streams that CANNOT be safely synced under the current loader
   * config (`upsert: true`). Specifically: tables without a primary
   * key, where tap-postgres emits no `key_properties` and z3z1ma's
   * MERGE step silently fails — leaving the canonical table stale
   * and littering staging copies. We exclude them from the tap's
   * select-list entirely rather than let them break syncs silently.
   *
   * Stream-name format matches `streams` keys above (`<schema>-<table>`).
   * Sync routes pass this to the Cloud Run Job as
   * `LIVELI_EXCLUDED_STREAMS` env; entrypoint.sh writes it into the
   * meltano.yml `select:` block as `!<stream>.*` exclusions.
   *
   * Surfaced to the user at connect time so they know which tables
   * won't appear in their dataset. Follow-up work to support these
   * via a parallel `overwrite: true` extractor invocation: LIVELI-?
   */
  excludedStreams: string[];
  /**
   * UI-facing summary of detection results. NOT consumed by Meltano.
   * One entry per table, including ones that fell through to FULL_TABLE
   * or are excluded entirely.
   */
  detected: DetectedTable[];
}

export interface DetectedTable {
  schema: string;
  table: string;
  /**
   * The replication outcome for this table.
   *   - INCREMENTAL: delta extracted each sync, MERGE on PK preserves history.
   *   - FULL_TABLE: full snapshot each sync, MERGE on PK preserves history
   *     (PK rows present in source survive; deletes don't propagate — known).
   *   - EXCLUDED: cannot be synced safely (no PK → upsert silently fails).
   */
  method: "INCREMENTAL" | "FULL_TABLE" | "EXCLUDED";
  /** Replication key column, when method is INCREMENTAL. */
  key?: string;
  /** Type of the chosen key column, for UI display. */
  keyType?: string;
  /** Human-readable explanation: "found `updated_at` timestamp column", etc. */
  rationale: string;
}

interface PgColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
}

interface PgPrimaryKey {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
}

/**
 * Connect to the customer's postgres, introspect schemas, return per-table
 * replication configuration. Throws on connection failure — the connect
 * route catches and converts to a user-facing error.
 */
export async function introspectPostgresSchema(
  params: PostgresConnectionParams
): Promise<ReplicationConfig> {
  const client = new Client({
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    password: params.password,
    // rejectUnauthorized:false because many managed providers (Neon,
    // Supabase, RDS without bundled CA) use self-signed or unverified
    // certs. We've already established the source's identity via the
    // customer providing the host name. Matches what the Meltano image
    // will do at sync time, so introspection and sync see the same data.
    ssl: params.ssl !== false ? { rejectUnauthorized: false } : false,
    // Hard bounds — introspection should be fast. If the customer's DB
    // takes >10s to respond to INFORMATION_SCHEMA queries, surface the
    // problem at connect time rather than letting the wizard hang.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });

  try {
    await client.connect();

    // 1) All base tables in scope.
    const tablesRes = await client.query<{
      table_schema: string;
      table_name: string;
    }>(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_schema = ANY($1)
         AND table_type = 'BASE TABLE'
       ORDER BY table_schema, table_name`,
      [params.schemas]
    );

    // 2) Columns for those tables, with types.
    const columnsRes = await client.query<PgColumn>(
      `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = ANY($1)`,
      [params.schemas]
    );

    // 3) Primary key columns per table. A composite PK shows up as
    //    multiple rows for the same (schema, table) — handled below.
    const pksRes = await client.query<PgPrimaryKey>(
      `SELECT kcu.table_schema, kcu.table_name, kcu.column_name, c.data_type
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema   = kcu.table_schema
       JOIN information_schema.columns c
         ON kcu.table_schema = c.table_schema
         AND kcu.table_name  = c.table_name
         AND kcu.column_name = c.column_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = ANY($1)
       ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position`,
      [params.schemas]
    );

    // Index columns by table for O(1) lookup during decision.
    const columnsByTable = new Map<string, PgColumn[]>();
    for (const col of columnsRes.rows) {
      const key = `${col.table_schema}.${col.table_name}`;
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      columnsByTable.get(key)!.push(col);
    }

    const pksByTable = new Map<string, PgPrimaryKey[]>();
    for (const pk of pksRes.rows) {
      const key = `${pk.table_schema}.${pk.table_name}`;
      if (!pksByTable.has(key)) pksByTable.set(key, []);
      pksByTable.get(key)!.push(pk);
    }

    const streams: Record<string, StreamReplicationConfig> = {};
    const excludedStreams: string[] = [];
    const detected: DetectedTable[] = [];

    for (const { table_schema, table_name } of tablesRes.rows) {
      const key = `${table_schema}.${table_name}`;
      const columns = columnsByTable.get(key) ?? [];
      const pkColumns = pksByTable.get(key) ?? [];

      // Meltano stream name convention for meltanolabs-tap-postgres:
      // `<schema>-<table>` (dash, not dot or underscore).
      const streamName = `${table_schema}-${table_name}`;

      // Hard prerequisite for upsert-mode sync: the table MUST have a
      // single-column primary key. tap-postgres emits `key_properties`
      // from the source's PRIMARY KEY constraint, and z3z1ma's
      // target-bigquery in upsert mode uses those keys for the MERGE
      // step. Tables without a PK silently fail MERGE (the canonical
      // table stays stale, staging copies pile up — confirmed in
      // production, see LIVELI-111). Composite PKs aren't supported by
      // the loader's MERGE either.
      //
      // We EXCLUDE these tables from sync rather than let them corrupt
      // silently. Surfaced to the user at connect time so they can
      // decide: add a PK to the source table, or wait for the
      // follow-up that adds an `overwrite: true` extractor invocation
      // for no-PK tables.
      const hasSingleColumnPk = pkColumns.length === 1;
      if (!hasSingleColumnPk) {
        excludedStreams.push(streamName);
        let reason: string;
        if (pkColumns.length === 0) {
          reason = `Excluded from sync: no primary key on the source table. BigQuery MERGE requires a key — add a PK to enable replication. (See LIVELI-111 follow-up for a future full-refresh sync path that handles no-PK tables.)`;
        } else {
          reason = `Excluded from sync: composite primary key (${pkColumns.length} columns) is not supported by the current MERGE-on-PK loader. (See LIVELI-111 follow-up for a future full-refresh sync path that handles composite keys.)`;
        }
        detected.push({
          schema: table_schema,
          table: table_name,
          method: "EXCLUDED",
          rationale: reason,
        });
        continue;
      }

      // Step 1 — look for a timestamp-named column we recognise as a
      // replication key. Combined with the single-column PK below, an
      // INCREMENTAL stream extracts only the delta (WHERE replication-key
      // > bookmark) and target-bigquery MERGEs the delta onto the
      // canonical table using key_properties from the PK. History
      // preserved, cost scales with delta size — the canonical
      // incremental-sync flow.
      //
      // Two tiers: prefer "update-aware" (updated_at-family) over
      // "insert-only" (created_at-family). Validate the actual data
      // type is timestamp-ish — a column named updated_at that's
      // somehow a varchar would break the tap's comparison logic.
      const tsCandidate = findTimestampKey(columns);
      if (tsCandidate) {
        streams[streamName] = {
          "replication-method": "INCREMENTAL",
          "replication-key": tsCandidate.column.column_name,
        };
        // Rationale differs by tier so the customer sees the trade-off.
        // Update-aware keys = full insert+update coverage.
        // Insert-only keys = inserts only, updates silently missed.
        const rationale =
          tsCandidate.tier === "update-aware"
            ? `Incremental by \`${tsCandidate.column.column_name}\` (${tsCandidate.column.data_type}). Captures inserts and updates — this is the column the source bumps whenever a row changes. MERGE on primary key \`${pkColumns[0].column_name}\`.`
            : `Incremental by \`${tsCandidate.column.column_name}\` (${tsCandidate.column.data_type}). No \`updated_at\`-style column found, so this is the next best bookmark: captures inserts but won't catch updates to existing rows. Use Full Refresh to resync after schema-only changes. MERGE on primary key \`${pkColumns[0].column_name}\`.`;
        detected.push({
          schema: table_schema,
          table: table_name,
          method: "INCREMENTAL",
          key: tsCandidate.column.column_name,
          keyType: tsCandidate.column.data_type,
          rationale,
        });
        continue;
      }

      // Step 2 — single-column integer PK with no timestamp column. The
      // PK itself is monotonically-ish increasing (sequence), so use it
      // as the bookmark. Captures inserts only — UPDATEs to existing
      // rows where the PK doesn't change will be silently missed
      // because the WHERE pk > bookmark filter excludes them.
      if (INTEGER_DATA_TYPES.has(pkColumns[0].data_type)) {
        const pk = pkColumns[0];
        streams[streamName] = {
          "replication-method": "INCREMENTAL",
          "replication-key": pk.column_name,
        };
        detected.push({
          schema: table_schema,
          table: table_name,
          method: "INCREMENTAL",
          key: pk.column_name,
          keyType: pk.data_type,
          rationale: `Incremental by primary key \`${pk.column_name}\` (${pk.data_type}). Captures inserts only — updates to existing rows won't sync until you Full Refresh. MERGE on the same primary key.`,
        });
        continue;
      }

      // Step 3 — single-column PK but non-integer (UUID, string, etc.)
      // and no timestamp column. Can't use the PK as a bookmark
      // (non-monotonic). Fall back to FULL_TABLE replication: every
      // sync emits all rows, target-bigquery MERGEs on the PK so
      // history is preserved correctly (insertions / updates land,
      // deletes from source don't propagate — known limitation).
      // Slower than INCREMENTAL but correct.
      streams[streamName] = { "replication-method": "FULL_TABLE" };
      detected.push({
        schema: table_schema,
        table: table_name,
        method: "FULL_TABLE",
        rationale: `Full extract every sync — primary key is \`${pkColumns[0].column_name}\` (${pkColumns[0].data_type}, non-integer) and no \`updated_at\`-style column was found, so no usable bookmark. MERGE on PK still preserves history; just costs more per sync.`,
      });
    }

    return { streams, excludedStreams, detected };
  } finally {
    // pg's Client doesn't have an idempotent close — but end() on an
    // unconnected client throws. Try/catch the cleanup so it doesn't
    // mask the original error if the connect itself blew up.
    try {
      await client.end();
    } catch {
      /* already closed / never opened */
    }
  }
}

/**
 * Find the first column whose lowercased name matches a known
 * timestamp candidate AND whose data type is one we trust as a
 * bookmark. Returns both the column and which tier matched, so the
 * caller can emit a tier-specific rationale message (update-aware
 * keys capture updates; insert-only keys don't).
 *
 * Search order:
 *   1. All UPDATE_AWARE keys, in their declared order.
 *   2. All INSERT_ONLY keys, in their declared order.
 *
 * Returns undefined if no recognised name matches with a valid type.
 */
type TimestampKeyMatch = {
  column: PgColumn;
  tier: "update-aware" | "insert-only";
};

function findTimestampKey(columns: PgColumn[]): TimestampKeyMatch | undefined {
  const byLowerName = new Map<string, PgColumn>();
  for (const col of columns) {
    byLowerName.set(col.column_name.toLowerCase(), col);
  }

  for (const name of UPDATE_AWARE_TIMESTAMP_KEYS) {
    const col = byLowerName.get(name);
    if (col && TIMESTAMP_DATA_TYPES.has(col.data_type)) {
      return { column: col, tier: "update-aware" };
    }
  }

  for (const name of INSERT_ONLY_TIMESTAMP_KEYS) {
    const col = byLowerName.get(name);
    if (col && TIMESTAMP_DATA_TYPES.has(col.data_type)) {
      return { column: col, tier: "insert-only" };
    }
  }

  return undefined;
}
