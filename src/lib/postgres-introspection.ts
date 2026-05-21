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

// Replication-key column-name preference order. First match wins.
// Lower-cased here; we match `column_name.toLowerCase()` against this.
const TIMESTAMP_KEY_CANDIDATES = [
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
   * UI-facing summary of detection results. NOT consumed by Meltano.
   * One entry per table, including ones that fell through to FULL_TABLE.
   */
  detected: DetectedTable[];
}

export interface DetectedTable {
  schema: string;
  table: string;
  method: "INCREMENTAL" | "FULL_TABLE";
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
    const detected: DetectedTable[] = [];

    for (const { table_schema, table_name } of tablesRes.rows) {
      const key = `${table_schema}.${table_name}`;
      const columns = columnsByTable.get(key) ?? [];
      const pkColumns = pksByTable.get(key) ?? [];

      // Meltano stream name convention for meltanolabs-tap-postgres:
      // `<schema>-<table>` (dash, not dot or underscore).
      const streamName = `${table_schema}-${table_name}`;

      // Step 1 — look for a timestamp-named column we recognize, prefer
      // the first match in TIMESTAMP_KEY_CANDIDATES order. Validate the
      // column's actual type is timestamp-ish (a column named updated_at
      // that's somehow a varchar would break the tap's comparison logic).
      const tsCandidate = findTimestampKey(columns);
      if (tsCandidate) {
        streams[streamName] = {
          "replication-method": "INCREMENTAL",
          "replication-key": tsCandidate.column_name,
        };
        detected.push({
          schema: table_schema,
          table: table_name,
          method: "INCREMENTAL",
          key: tsCandidate.column_name,
          keyType: tsCandidate.data_type,
          rationale: `Incremental by \`${tsCandidate.column_name}\` (${tsCandidate.data_type}). Captures inserts and updates.`,
        });
        continue;
      }

      // Step 2 — single-column integer PK. Use as bookmark; captures
      // inserts only. Better than nothing, worse than a real timestamp.
      if (pkColumns.length === 1 && INTEGER_DATA_TYPES.has(pkColumns[0].data_type)) {
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
          rationale: `Incremental by primary key \`${pk.column_name}\` (${pk.data_type}). Captures inserts only — updates to existing rows won't sync until you Full Refresh.`,
        });
        continue;
      }

      // Step 3 — fall back to full extract. Note the reason so the UI
      // can hint at the cause ("no PK and no updated_at column").
      streams[streamName] = { "replication-method": "FULL_TABLE" };

      let reason: string;
      if (pkColumns.length > 1) {
        reason = `Composite primary key (${pkColumns.length} columns) — Meltano supports only a single replication key. Full extract every sync.`;
      } else if (pkColumns.length === 1) {
        reason = `Primary key is \`${pkColumns[0].column_name}\` (${pkColumns[0].data_type}) — non-integer types aren't usable as a sequence bookmark. Full extract every sync.`;
      } else {
        reason = `No primary key and no recognised timestamp column. Full extract every sync.`;
      }
      detected.push({
        schema: table_schema,
        table: table_name,
        method: "FULL_TABLE",
        rationale: reason,
      });
    }

    return { streams, detected };
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
 * Find the first column whose lowercased name matches our timestamp
 * candidate list AND whose data type is one we trust as a bookmark.
 */
function findTimestampKey(columns: PgColumn[]): PgColumn | undefined {
  const byLowerName = new Map<string, PgColumn>();
  for (const col of columns) {
    byLowerName.set(col.column_name.toLowerCase(), col);
  }
  for (const candidateName of TIMESTAMP_KEY_CANDIDATES) {
    const col = byLowerName.get(candidateName);
    if (col && TIMESTAMP_DATA_TYPES.has(col.data_type)) {
      return col;
    }
  }
  return undefined;
}
