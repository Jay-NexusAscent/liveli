import oracledb from "oracledb";

/**
 * Detect replication strategy per table at oracle-connect time.
 *
 * This is the Oracle analogue of lib/postgres-introspection.ts and
 * follows the SAME contract, because Oracle (unlike Snowflake) ENFORCES
 * primary keys — so the postgres model fits cleanly:
 *
 *   - Loader runs GLOBAL `upsert: true` (MERGE on the PK the tap emits
 *     from ALL_CONSTRAINTS constraint_type='P').
 *   - Tables WITH a single-column PK get INCREMENTAL when an
 *     `updated_at`-style timestamp (or an integer PK) is available,
 *     FULL_TABLE otherwise. In both cases the loader MERGEs on the PK,
 *     so history is preserved.
 *   - Tables WITHOUT a single-column PK are EXCLUDED from sync — under
 *     `upsert: true` they emit no key_properties and z3z1ma's MERGE
 *     silently fails, leaving the canonical stale + leaking staging
 *     tables (the LIVELI-111 failure mode). Surfaced to the user at
 *     connect time.
 *
 * Runs in the Vercel nodejs runtime via the `oracledb` THIN driver
 * (pure JS, no Instant Client) — set by NOT calling initOracleClient().
 *
 * Stream-name convention matches s7clarke10/pipelinewise-tap-oracle:
 * `<OWNER>-<TABLE>` (uppercase, hyphen) — built verbatim from
 * `table_schema + '-' + table_name` in the tap. Oracle stores unquoted
 * identifiers UPPERCASE, so the keys we emit here MUST be uppercase or
 * the meltano.yml `metadata:` overrides silently no-op.
 */

// Replication-key column-name preference, two tiers — identical policy
// to postgres-introspection.ts. Update-aware keys (advance on every
// mutation) capture inserts AND updates; insert-only keys capture
// inserts only. First match within a tier wins; TIER 1 before TIER 2.
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

// Oracle system/internal schemas we never replicate even if the user
// somehow names them. The tap itself excludes SYS; we additionally guard
// the common dictionary/admin owners so a bad `filter_schemas` can't drag
// them in.
const SYSTEM_OWNERS = new Set([
  "SYS",
  "SYSTEM",
  "OUTLN",
  "DBSNMP",
  "APPQOSSYS",
  "AUDSYS",
  "GSMADMIN_INTERNAL",
  "XDB",
  "WMSYS",
  "OJVMSYS",
  "CTXSYS",
  "ORDSYS",
  "MDSYS",
  "LBACSYS",
  "DVSYS",
]);

export interface OracleConnectionParams {
  host: string;
  port: number;
  /** Oracle service name (host:port/service_name connect string). */
  serviceName: string;
  user: string;
  password: string;
  /**
   * Schema owners to introspect. Oracle identifiers are uppercase by
   * default; callers should uppercase before passing. When empty we
   * default to the connecting user's own schema (uppercased username).
   */
  schemas: string[];
}

export type StreamReplicationConfig = {
  "replication-method": "INCREMENTAL" | "FULL_TABLE";
  "replication-key"?: string;
};

export interface ReplicationConfig {
  /**
   * Per-stream Meltano metadata overrides, keyed `<OWNER>-<TABLE>`
   * (uppercase) to match pipelinewise-tap-oracle's tap_stream_id.
   * Injected into meltano.yml's extractor `metadata:` block at sync time.
   */
  streams: Record<string, StreamReplicationConfig>;
  /**
   * Streams excluded from sync (no single-column PK → incompatible with
   * the loader's `upsert: true` MERGE). Stream-name format matches
   * `streams` keys. Emitted as LIVELI_EXCLUDED_STREAMS; entrypoint.sh
   * writes them into the meltano.yml `select:` block as `!<stream>.*`.
   */
  excludedStreams: string[];
  /** UI-facing per-table summary. NOT consumed by Meltano. */
  detected: DetectedTable[];
}

export interface DetectedTable {
  schema: string;
  table: string;
  method: "INCREMENTAL" | "FULL_TABLE" | "EXCLUDED";
  key?: string;
  keyType?: string;
  rationale: string;
}

interface OraColumn {
  OWNER: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  DATA_SCALE: number | null;
}

interface OraPk {
  OWNER: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
}

/**
 * Connect to the customer's Oracle DB, introspect the requested schema
 * owners, return per-table replication configuration. Throws on
 * connection failure — the connect route catches and converts to a
 * user-facing error (doubles as a creds liveness check).
 */
export async function introspectOracleSchema(
  params: OracleConnectionParams
): Promise<ReplicationConfig> {
  // THIN mode (default in node-oracledb v6+) — pure JS, no Instant
  // Client binary, works on Vercel serverless. Never call
  // oracledb.initOracleClient() (that flips to thick/native mode).
  let connection: oracledb.Connection | undefined;
  try {
    connection = await oracledb.getConnection({
      user: params.user,
      password: params.password,
      connectString: `${params.host}:${params.port}/${params.serviceName}`,
    });

    // Default to the connecting user's own schema when none specified.
    const owners = (
      params.schemas.length > 0 ? params.schemas : [params.user.toUpperCase()]
    )
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && !SYSTEM_OWNERS.has(s));

    if (owners.length === 0) {
      return { streams: {}, excludedStreams: [], detected: [] };
    }

    // Oracle bind lists must be expanded to :0,:1,… positional binds.
    const ownerBinds = owners.map((_, i) => `:${i}`).join(",");

    connection.callTimeout = 10_000;
    const fmt = { outFormat: oracledb.OUT_FORMAT_OBJECT };

    // 1) Base tables in scope.
    const tablesRes = await connection.execute<{
      OWNER: string;
      TABLE_NAME: string;
    }>(
      `SELECT owner, table_name FROM all_tables
        WHERE owner IN (${ownerBinds})
        ORDER BY owner, table_name`,
      owners,
      fmt
    );

    // 2) Columns + types (DATA_SCALE distinguishes integer NUMBER(*,0)).
    const columnsRes = await connection.execute<OraColumn>(
      `SELECT owner, table_name, column_name, data_type, data_scale
         FROM all_tab_columns
        WHERE owner IN (${ownerBinds})`,
      owners,
      fmt
    );

    // 3) Primary key columns (constraint_type='P'). Composite PKs show
    //    up as multiple rows per (owner, table) — handled below.
    const pksRes = await connection.execute<OraPk>(
      `SELECT cc.owner, cc.table_name, cc.column_name
         FROM all_constraints c
         JOIN all_cons_columns cc
           ON c.owner = cc.owner
          AND c.constraint_name = cc.constraint_name
        WHERE c.constraint_type = 'P'
          AND c.owner IN (${ownerBinds})
        ORDER BY cc.owner, cc.table_name, cc.position`,
      owners,
      fmt
    );

    const columnsByTable = new Map<string, OraColumn[]>();
    for (const col of columnsRes.rows ?? []) {
      const key = `${col.OWNER}.${col.TABLE_NAME}`;
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      columnsByTable.get(key)!.push(col);
    }

    const pksByTable = new Map<string, OraPk[]>();
    for (const pk of pksRes.rows ?? []) {
      const key = `${pk.OWNER}.${pk.TABLE_NAME}`;
      if (!pksByTable.has(key)) pksByTable.set(key, []);
      pksByTable.get(key)!.push(pk);
    }

    const streams: Record<string, StreamReplicationConfig> = {};
    const excludedStreams: string[] = [];
    const detected: DetectedTable[] = [];

    for (const { OWNER, TABLE_NAME } of tablesRes.rows ?? []) {
      const key = `${OWNER}.${TABLE_NAME}`;
      const columns = columnsByTable.get(key) ?? [];
      const pkColumns = pksByTable.get(key) ?? [];
      // tap-oracle stream id: `<OWNER>-<TABLE>` (uppercase, hyphen).
      const streamName = `${OWNER}-${TABLE_NAME}`;

      // Single-column PK is the hard prerequisite for upsert-mode MERGE.
      const hasSingleColumnPk = pkColumns.length === 1;
      if (!hasSingleColumnPk) {
        excludedStreams.push(streamName);
        const reason =
          pkColumns.length === 0
            ? `Excluded from sync: no primary key on the source table. BigQuery MERGE requires a key — add a PK to enable replication. (LIVELI-111 follow-up will add a full-refresh path for no-PK tables.)`
            : `Excluded from sync: composite primary key (${pkColumns.length} columns) is not supported by the MERGE-on-PK loader. (LIVELI-111 follow-up will add a path for composite keys.)`;
        detected.push({
          schema: OWNER,
          table: TABLE_NAME,
          method: "EXCLUDED",
          rationale: reason,
        });
        continue;
      }

      // Step 1 — recognised timestamp column → INCREMENTAL.
      const tsCandidate = findTimestampKey(columns);
      if (tsCandidate) {
        streams[streamName] = {
          "replication-method": "INCREMENTAL",
          "replication-key": tsCandidate.column.COLUMN_NAME,
        };
        const rationale =
          tsCandidate.tier === "update-aware"
            ? `Incremental by \`${tsCandidate.column.COLUMN_NAME}\` (${tsCandidate.column.DATA_TYPE}). Captures inserts and updates. MERGE on primary key \`${pkColumns[0].COLUMN_NAME}\`.`
            : `Incremental by \`${tsCandidate.column.COLUMN_NAME}\` (${tsCandidate.column.DATA_TYPE}). No \`updated_at\`-style column found — captures inserts but not updates to existing rows. MERGE on primary key \`${pkColumns[0].COLUMN_NAME}\`.`;
        detected.push({
          schema: OWNER,
          table: TABLE_NAME,
          method: "INCREMENTAL",
          key: tsCandidate.column.COLUMN_NAME,
          keyType: tsCandidate.column.DATA_TYPE,
          rationale,
        });
        continue;
      }

      // Step 2 — integer PK (NUMBER with scale 0), no timestamp column.
      // Use the PK as an insert-only bookmark.
      const pkCol = columns.find(
        (c) => c.COLUMN_NAME === pkColumns[0].COLUMN_NAME
      );
      if (pkCol && isIntegerNumber(pkCol)) {
        streams[streamName] = {
          "replication-method": "INCREMENTAL",
          "replication-key": pkColumns[0].COLUMN_NAME,
        };
        detected.push({
          schema: OWNER,
          table: TABLE_NAME,
          method: "INCREMENTAL",
          key: pkColumns[0].COLUMN_NAME,
          keyType: pkCol.DATA_TYPE,
          rationale: `Incremental by primary key \`${pkColumns[0].COLUMN_NAME}\` (${pkCol.DATA_TYPE}). Captures inserts only — updates won't sync until you Full Refresh. MERGE on the same primary key.`,
        });
        continue;
      }

      // Step 3 — single-column non-integer PK (e.g. VARCHAR2 id), no
      // timestamp column → FULL_TABLE. MERGE on PK still preserves
      // history; just costs a full extract each sync.
      streams[streamName] = { "replication-method": "FULL_TABLE" };
      detected.push({
        schema: OWNER,
        table: TABLE_NAME,
        method: "FULL_TABLE",
        rationale: `Full extract every sync — primary key \`${pkColumns[0].COLUMN_NAME}\` is non-integer and no \`updated_at\`-style column was found, so there's no usable bookmark. MERGE on PK still preserves history.`,
      });
    }

    return { streams, excludedStreams, detected };
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch {
        /* already closed / never opened */
      }
    }
  }
}

/** NUMBER with scale 0 (or unspecified integer) is an integer column. */
function isIntegerNumber(col: OraColumn): boolean {
  return col.DATA_TYPE === "NUMBER" && (col.DATA_SCALE === 0 || col.DATA_SCALE === null);
}

type TimestampKeyMatch = {
  column: OraColumn;
  tier: "update-aware" | "insert-only";
};

/**
 * First column whose UPPERCASE name matches a known timestamp candidate
 * AND whose Oracle data type is date/timestamp-ish. UPDATE_AWARE tier
 * is exhausted before INSERT_ONLY.
 */
function findTimestampKey(columns: OraColumn[]): TimestampKeyMatch | undefined {
  const byName = new Map<string, OraColumn>();
  for (const col of columns) byName.set(col.COLUMN_NAME.toUpperCase(), col);

  const isTimestampish = (c: OraColumn) =>
    c.DATA_TYPE === "DATE" || c.DATA_TYPE.startsWith("TIMESTAMP");

  for (const name of UPDATE_AWARE_TIMESTAMP_KEYS) {
    const col = byName.get(name);
    if (col && isTimestampish(col)) return { column: col, tier: "update-aware" };
  }
  for (const name of INSERT_ONLY_TIMESTAMP_KEYS) {
    const col = byName.get(name);
    if (col && isTimestampish(col)) return { column: col, tier: "insert-only" };
  }
  return undefined;
}
