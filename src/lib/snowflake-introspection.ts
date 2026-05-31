import snowflake from "snowflake-sdk";

/**
 * Detect replication strategy per table at snowflake-connect time.
 *
 * Snowflake is NOT a postgres clone: it does NOT enforce primary keys,
 * so most customer tables have none. The postgres "exclude every no-PK
 * table" rule would drop most of a warehouse — unacceptable. Instead we
 * exploit z3z1ma target-bigquery's PER-STREAM write modes (the `upsert`
 * and `overwrite` config keys accept fnmatch pattern lists; streams
 * matching neither fall through to APPEND, the default). That lets a
 * single sync route each table to the correct mode:
 *
 *   has PK + timestamp col  → INCREMENTAL + upsert   (cheap, no dupes)
 *   has PK,  no timestamp   → FULL_TABLE  + upsert   (full read, no dupes)
 *   no PK,   timestamp col  → INCREMENTAL + append   (cheap, row-versions)
 *   no PK,   no timestamp   → FULL_TABLE  + overwrite(full replace)
 *
 * No table is ever excluded. INCREMENTAL needs only a sortable bookmark
 * (no PK); upsert MERGE needs key_properties (a PK) — these are separate
 * requirements, which is why a no-PK table can still sync incrementally
 * via append.
 *
 * Runs in the Vercel nodejs runtime via the `snowflake-sdk` package.
 *
 * Stream-name convention matches MeltanoLabs/tap-snowflake (singer-sdk
 * SQLConnector): `<SCHEMA>-<TABLE>` (hyphen, no database prefix). Case is
 * preserved as the inspector returns it — Snowflake unquoted identifiers
 * are UPPERCASE, so our metadata keys + patterns are uppercase or they
 * silently no-op. The tap's `tables` discovery setting, by contrast, uses
 * dotted `<SCHEMA>.<TABLE>` — we emit both forms.
 */

const UPDATE_AWARE_TIMESTAMP_KEYS = [
  "UPDATED_AT",
  "MODIFIED_AT",
  "LAST_MODIFIED",
  "LAST_MODIFIED_AT",
  "LAST_UPDATED",
  "LAST_UPDATED_AT",
  "LAST_CHANGED",
  "UPDATED_DT",
  "MOD_DT",
];

const INSERT_ONLY_TIMESTAMP_KEYS = [
  "CREATED_AT",
  "CREATE_DT",
  "PLACED_AT",
  "STARTED_AT",
  "OCCURRED_AT",
  "HAPPENED_AT",
  "EVENT_AT",
  "SHIPPED_AT",
  "DELIVERED_AT",
  "PROCESSED_AT",
  "REQUESTED_AT",
  "COMPLETED_AT",
  "SIGNUP_DATE",
  "REGISTERED_AT",
];

export interface SnowflakeConnectionParams {
  account: string;
  user: string;
  password: string;
  database: string;
  warehouse: string;
  /** Optional single schema to scope discovery to. Blank = all schemas. */
  schema?: string;
}

export type StreamReplicationConfig = {
  "replication-method": "INCREMENTAL" | "FULL_TABLE";
  "replication-key"?: string;
};

export interface SnowflakeReplicationConfig {
  /** Per-stream tap metadata, keyed `<SCHEMA>-<TABLE>` (uppercase). */
  streams: Record<string, StreamReplicationConfig>;
  /**
   * Dotted `<SCHEMA>.<TABLE>` list for tap-snowflake's `tables` discovery
   * setting — scopes discovery to exactly these tables (the tap has no
   * filter_schemas). Emitted as TAP_SNOWFLAKE_TABLES (JSON array).
   */
  tables: string[];
  /**
   * Stream patterns (`<SCHEMA>-<TABLE>`) the loader should MERGE on the
   * PK — tables with a detected primary key. Emitted as
   * LIVELI_UPSERT_STREAMS; entrypoint.sh writes them into the loader's
   * `upsert` config (fnmatch list).
   */
  upsertStreams: string[];
  /**
   * Stream patterns the loader should atomically REPLACE each run —
   * no-PK tables with no usable bookmark (FULL_TABLE). Emitted as
   * LIVELI_OVERWRITE_STREAMS → loader `overwrite` config. Everything in
   * neither list appends (z3z1ma default).
   */
  overwriteStreams: string[];
  /** UI-facing per-table summary. NOT consumed by Meltano. */
  detected: DetectedTable[];
}

export interface DetectedTable {
  schema: string;
  table: string;
  method: "INCREMENTAL" | "FULL_TABLE";
  loadMode: "upsert" | "append" | "overwrite";
  key?: string;
  keyType?: string;
  rationale: string;
}

interface SfRow {
  [col: string]: unknown;
}

/** Promisified single-statement execute. */
function execute(
  conn: snowflake.Connection,
  sqlText: string,
  binds: snowflake.Binds = []
): Promise<SfRow[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve((rows as SfRow[]) ?? []);
      },
    });
  });
}

function connect(
  params: SnowflakeConnectionParams
): Promise<snowflake.Connection> {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: params.account,
      username: params.user,
      password: params.password,
      database: params.database,
      warehouse: params.warehouse,
      ...(params.schema ? { schema: params.schema } : {}),
      // Bounded — discovery should be fast; surface dead creds at the
      // wizard, not 15 minutes into the first sync.
      timeout: 10_000,
    });
    conn.connect((err, c) => {
      if (err) reject(err);
      else resolve(c);
    });
  });
}

/**
 * Connect to the customer's Snowflake, introspect tables/columns/PKs in
 * the target database (optionally scoped to one schema), return the
 * per-stream replication + per-stream loader-mode plan. Throws on
 * connection failure — the connect route catches and converts to a
 * user-facing error (doubles as a creds liveness check).
 */
export async function introspectSnowflakeSchema(
  params: SnowflakeConnectionParams
): Promise<SnowflakeReplicationConfig> {
  let conn: snowflake.Connection | undefined;
  try {
    conn = await connect(params);
    const db = params.database.toUpperCase();
    const schemaFilter = params.schema?.trim().toUpperCase();

    // 1) Base tables (exclude the reserved INFORMATION_SCHEMA).
    const tablesSql =
      `SELECT TABLE_SCHEMA, TABLE_NAME FROM IDENTIFIER(?).INFORMATION_SCHEMA.TABLES ` +
      `WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'` +
      (schemaFilter ? ` AND TABLE_SCHEMA = ?` : ``) +
      ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;
    const tableRows = await execute(
      conn,
      tablesSql,
      schemaFilter ? [`${db}`, schemaFilter] : [`${db}`]
    );

    // 2) Columns + types + numeric scale (integer detection).
    const colsSql =
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, NUMERIC_SCALE ` +
      `FROM IDENTIFIER(?).INFORMATION_SCHEMA.COLUMNS ` +
      `WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA'` +
      (schemaFilter ? ` AND TABLE_SCHEMA = ?` : ``);
    const colRows = await execute(
      conn,
      colsSql,
      schemaFilter ? [`${db}`, schemaFilter] : [`${db}`]
    );

    // 3) Primary keys for the whole database in one call. INFORMATION_
    //    SCHEMA.TABLE_CONSTRAINTS does NOT exist in Snowflake — SHOW
    //    PRIMARY KEYS is the supported path (what snowflake-sqlalchemy
    //    uses internally). Returns schema_name/table_name/column_name.
    let pkRows: SfRow[] = [];
    try {
      pkRows = await execute(
        conn,
        `SHOW PRIMARY KEYS IN DATABASE IDENTIFIER(?)`,
        [`${db}`]
      );
    } catch {
      // No PKs / insufficient privilege — treat as "no PKs anywhere".
      pkRows = [];
    }

    const str = (v: unknown) => (v == null ? "" : String(v));

    const columnsByTable = new Map<
      string,
      { name: string; type: string; scale: number | null }[]
    >();
    for (const r of colRows) {
      const key = `${str(r.TABLE_SCHEMA)}.${str(r.TABLE_NAME)}`;
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      const scaleRaw = r.NUMERIC_SCALE;
      columnsByTable.get(key)!.push({
        name: str(r.COLUMN_NAME),
        type: str(r.DATA_TYPE).toUpperCase(),
        scale: scaleRaw == null ? null : Number(scaleRaw),
      });
    }

    // SHOW PRIMARY KEYS columns are lowercase: schema_name, table_name,
    // column_name. Count columns per table to detect composite PKs.
    const pkColsByTable = new Map<string, string[]>();
    for (const r of pkRows) {
      const schema = str(r.schema_name ?? r.SCHEMA_NAME);
      const table = str(r.table_name ?? r.TABLE_NAME);
      const column = str(r.column_name ?? r.COLUMN_NAME);
      const key = `${schema}.${table}`;
      if (!pkColsByTable.has(key)) pkColsByTable.set(key, []);
      pkColsByTable.get(key)!.push(column);
    }

    const streams: Record<string, StreamReplicationConfig> = {};
    const tables: string[] = [];
    const upsertStreams: string[] = [];
    const overwriteStreams: string[] = [];
    const detected: DetectedTable[] = [];

    for (const row of tableRows) {
      const schema = str(row.TABLE_SCHEMA);
      const table = str(row.TABLE_NAME);
      const fqKey = `${schema}.${table}`;
      const streamName = `${schema}-${table}`; // tap-snowflake stream id
      tables.push(fqKey);

      const columns = columnsByTable.get(fqKey) ?? [];
      const pkCols = pkColsByTable.get(fqKey) ?? [];
      // Only a single-column PK is usable as a MERGE key.
      const hasUsablePk = pkCols.length === 1;
      const tsCandidate = findTimestampKey(columns);

      // Bookmark: timestamp col if present, else a single-column integer
      // PK (insert-only). Drives INCREMENTAL vs FULL_TABLE.
      let method: "INCREMENTAL" | "FULL_TABLE" = "FULL_TABLE";
      let key: string | undefined;
      let keyType: string | undefined;
      if (tsCandidate) {
        method = "INCREMENTAL";
        key = tsCandidate.column.name;
        keyType = tsCandidate.column.type;
      } else if (hasUsablePk) {
        const pkCol = columns.find((c) => c.name === pkCols[0]);
        if (pkCol && isIntegerNumber(pkCol)) {
          method = "INCREMENTAL";
          key = pkCol.name;
          keyType = pkCol.type;
        }
      }

      streams[streamName] =
        method === "INCREMENTAL"
          ? { "replication-method": "INCREMENTAL", "replication-key": key! }
          : { "replication-method": "FULL_TABLE" };

      // Loader mode: PK → upsert (MERGE, no dupes); no PK + bookmark →
      // append (default, row-versions); no PK + no bookmark → overwrite.
      let loadMode: "upsert" | "append" | "overwrite";
      let rationale: string;
      if (hasUsablePk) {
        loadMode = "upsert";
        upsertStreams.push(streamName);
        rationale =
          method === "INCREMENTAL"
            ? `Incremental by \`${key}\` (${keyType}), MERGE on primary key \`${pkCols[0]}\`. Cheap + no duplicates.`
            : `Full extract each sync, MERGE on primary key \`${pkCols[0]}\` — no usable bookmark column found.`;
      } else if (method === "INCREMENTAL") {
        loadMode = "append";
        rationale = `No primary key, so rows are appended (not merged) — incremental by \`${key}\` (${keyType}) keeps it cheap. Updates produce row-versions in BigQuery; dedupe downstream in dbt if needed.`;
      } else {
        loadMode = "overwrite";
        overwriteStreams.push(streamName);
        rationale = `No primary key and no \`updated_at\`-style bookmark column — the table is fully re-extracted and atomically replaced each sync (correct, but the most expensive mode).`;
      }

      detected.push({
        schema,
        table,
        method,
        loadMode,
        key,
        keyType,
        rationale,
      });
    }

    return { streams, tables, upsertStreams, overwriteStreams, detected };
  } finally {
    if (conn) {
      try {
        conn.destroy(() => {});
      } catch {
        /* already closed */
      }
    }
  }
}

function isIntegerNumber(col: { type: string; scale: number | null }): boolean {
  return col.type === "NUMBER" && (col.scale === 0 || col.scale === null);
}

type TimestampKeyMatch = {
  column: { name: string; type: string };
  tier: "update-aware" | "insert-only";
};

function findTimestampKey(
  columns: { name: string; type: string }[]
): TimestampKeyMatch | undefined {
  const byName = new Map<string, { name: string; type: string }>();
  for (const col of columns) byName.set(col.name.toUpperCase(), col);

  const isTimestampish = (t: string) =>
    t === "DATE" || t.startsWith("TIMESTAMP");

  for (const name of UPDATE_AWARE_TIMESTAMP_KEYS) {
    const col = byName.get(name);
    if (col && isTimestampish(col.type)) return { column: col, tier: "update-aware" };
  }
  for (const name of INSERT_ONLY_TIMESTAMP_KEYS) {
    const col = byName.get(name);
    if (col && isTimestampish(col.type)) return { column: col, tier: "insert-only" };
  }
  return undefined;
}
