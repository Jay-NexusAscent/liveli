/**
 * Per-connector-type mapping from the Secret Manager creds payload to the
 * `TAP_*` env vars that the Cloud Run Job entrypoint expects.
 *
 * Adding a new connector means:
 *   1. Drop the wizard, connect route, and image directory in place.
 *   2. Add a branch in TAP_ENV_BUILDERS below — keys must match the
 *      connector's `type` field on the Firestore connector doc (the
 *      same value used as `connector-<type>-to-bq` Cloud Run Job name).
 *   3. The corresponding entrypoint.sh checks each TAP_* var with
 *      `: "${TAP_X:?...}"` — those names MUST match what the builder
 *      returns here. If they drift the job exits with a missing-var
 *      message at run time.
 *
 * Callers: src/app/api/connections/[connectorId]/sync/route.ts and
 * src/app/api/connections/[connectorId]/scheduled-sync/route.ts. Keep
 * them thin — this file is the single source of truth.
 *
 * ── INCREMENTAL replication: precondition for new connectors ──────
 *
 * If your new connector needs per-stream replication overrides
 * (INCREMENTAL by a key column, FULL_TABLE for the rest, etc.) the
 * existing mechanism is `LIVELI_REPLICATION_CONFIG` — a JSON env var
 * the connector's entrypoint.sh merges into meltano.yml's
 * `extractor.metadata` block.
 *
 * Today this is wired ONLY for postgres (the introspection writer
 * lives in `lib/postgres-introspection.ts`). Other entrypoints do
 * NOT contain the merge block; re-adding it has a HARD precondition:
 *
 *   - The loader MUST be in `upsert: true` mode (see meltano.yml).
 *   - The tap MUST emit `key_properties` for every stream that will
 *     be set to INCREMENTAL.
 *
 * Why: a loader in `overwrite: true` mode atomically REPLACES the
 * target table on every sync. Combined with INCREMENTAL replication
 * the tap emits only the delta and the loader replaces the whole
 * table with that delta — all historical data wiped on every sync
 * after the first. See LIVELI-111: this is exactly how two years of
 * demo data got lost.
 *
 * mysql is currently on `overwrite: true` and intentionally does NOT
 * have the merge block, even though it's a DB connector. Until the
 * mysql loader flips to upsert AND PK gating equivalent to
 * lib/postgres-introspection.ts has been built, mysql streams must
 * stay on FULL_TABLE replication (the tap-mysql default).
 */

export class UnsupportedConnectorTypeError extends Error {
  constructor(public readonly type: string) {
    super(`Sync not yet wired for connector type: ${type}`);
    this.name = "UnsupportedConnectorTypeError";
  }
}

type Creds = Record<string, string>;

/**
 * Non-credential per-connector options passed alongside Secret Manager
 * creds. Used today for postgres' replicationConfig (auto-detected at
 * connect time, stored on the Firestore connector doc, NOT in Secret
 * Manager because it's not sensitive). The shape is intentionally loose
 * — type-narrowing happens per-builder.
 */
export interface BuildTapEnvOptions {
  /**
   * Meltano-format per-stream metadata overrides. For postgres this is
   * the `streams` field of ReplicationConfig (see lib/postgres-
   * introspection.ts). Other connector types may use it differently.
   * Emitted to the Cloud Run Job as the LIVELI_REPLICATION_CONFIG env
   * var, which the connector's entrypoint.sh merges into meltano.yml
   * at sync time.
   */
  replicationConfig?: unknown;
  /**
   * Streams to EXCLUDE from sync. For postgres this is tables without
   * a single-column primary key — the BQ loader runs in `upsert: true`
   * mode and MERGEs on `key_properties`; tables without a usable PK
   * would silently corrupt under MERGE, so we refuse to sync them.
   * Stream-name format matches the tap's discovery output
   * (`<schema>-<table>` for tap-postgres).
   *
   * Emitted as LIVELI_EXCLUDED_STREAMS (JSON array). Entrypoint.sh
   * writes them into the meltano.yml `select:` filter as `!<stream>.*`
   * exclusions so the tap doesn't emit those streams at all.
   */
  excludedStreams?: string[];
  /**
   * Per-stream loader-mode routing (snowflake). z3z1ma target-bigquery
   * accepts fnmatch pattern lists on its `upsert` and `overwrite` config
   * keys; streams matching neither append (the default). Lets one sync
   * MERGE the PK'd tables, overwrite the no-bookmark tables, and append
   * the rest. Emitted as LIVELI_UPSERT_STREAMS / LIVELI_OVERWRITE_STREAMS;
   * entrypoint.sh writes them into the loader config.
   */
  upsertStreams?: string[];
  overwriteStreams?: string[];
  /**
   * Dotted `<SCHEMA>.<TABLE>` discovery scope for taps that lack a
   * filter_schemas setting (snowflake). Emitted as the tap's `tables`
   * setting env var.
   */
  tables?: string[];
}

type EnvBuilder = (
  creds: Creds,
  options?: BuildTapEnvOptions
) => Record<string, string>;

const TAP_ENV_BUILDERS: Record<string, EnvBuilder> = {
  postgres: (creds, options) => {
    // filter_schemas restricts tap-postgres to user schemas only —
    // without it the tap discovers pg_catalog + information_schema, and
    // target-bigquery crashes trying to create `information_schema__pg_*`
    // tables because BQ reserves the `information_schema` prefix.
    const schemas = (creds.schemas ?? "public")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const env: Record<string, string> = {
      TAP_POSTGRES_HOST: creds.host,
      TAP_POSTGRES_PORT: creds.port,
      TAP_POSTGRES_USER: creds.user,
      TAP_POSTGRES_PASSWORD: creds.password,
      TAP_POSTGRES_DATABASE: creds.database,
      TAP_POSTGRES_FILTER_SCHEMAS: JSON.stringify(schemas),
    };
    // Auto-detected per-stream replication overrides from connect-time
    // introspection. Passed to the Cloud Run Job container; entrypoint.sh
    // merges these into meltano.yml's `metadata:` block via inline Python
    // before invoking `meltano elt`. When this is missing (older connectors
    // created before the introspection step landed), Meltano falls back
    // to its default — FULL_TABLE for every stream.
    if (options?.replicationConfig) {
      env.LIVELI_REPLICATION_CONFIG = JSON.stringify(options.replicationConfig);
    }
    // Tables without a single-column primary key — the loader's
    // `upsert: true` mode MERGEs on PK and would silently corrupt
    // these. We exclude them from the tap's discovered stream set at
    // sync time. See lib/postgres-introspection.ts for detection.
    if (options?.excludedStreams && options.excludedStreams.length > 0) {
      env.LIVELI_EXCLUDED_STREAMS = JSON.stringify(options.excludedStreams);
    }
    return env;
  },

  mysql: (creds) => {
    // Same gotcha as postgres — tap-mysql by default discovers
    // mysql/sys/performance_schema and target-bigquery dies on
    // BQ-reserved prefixes. filter_dbs scopes replication.
    const dbs = (creds.filter_dbs ?? creds.database ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      TAP_MYSQL_HOST: creds.host,
      TAP_MYSQL_PORT: creds.port,
      TAP_MYSQL_USER: creds.user,
      TAP_MYSQL_PASSWORD: creds.password,
      TAP_MYSQL_DATABASE: creds.database,
      TAP_MYSQL_SSL: creds.ssl ?? "false",
      TAP_MYSQL_FILTER_DBS: JSON.stringify(dbs),
    };
  },

  sqlserver: (creds) => {
    // tap-mssql (buzzcutnorman) — same reserved-prefix gotcha as
    // postgres: without filter_schemas the tap discovers sys +
    // INFORMATION_SCHEMA and target-bigquery dies on the BQ-reserved
    // `information_schema` prefix. `schemas` is the comma-separated
    // user input (defaults to MSSQL's `dbo` at the connect route).
    const schemas = (creds.schemas ?? "dbo")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      TAP_MSSQL_HOST: creds.host,
      TAP_MSSQL_PORT: creds.port,
      TAP_MSSQL_USER: creds.user,
      TAP_MSSQL_PASSWORD: creds.password,
      TAP_MSSQL_DATABASE: creds.database,
      TAP_MSSQL_FILTER_SCHEMAS: JSON.stringify(schemas),
    };
  },

  redshift: (creds) => {
    // Amazon Redshift is Postgres-wire-compatible, so it runs through
    // tap-postgres (env prefix TAP_POSTGRES_*). Treated like mysql, NOT
    // like the postgres connector: no replicationConfig/excludedStreams
    // (Redshift PKs are informational only — the loader runs overwrite +
    // FULL_TABLE). `schemas` defaults to `public` at the connect route.
    const schemas = (creds.schemas ?? "public")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      TAP_POSTGRES_HOST: creds.host,
      TAP_POSTGRES_PORT: creds.port,
      TAP_POSTGRES_USER: creds.user,
      TAP_POSTGRES_PASSWORD: creds.password,
      TAP_POSTGRES_DATABASE: creds.database,
      TAP_POSTGRES_FILTER_SCHEMAS: JSON.stringify(schemas),
    };
  },

  synapse: (creds) => {
    // Azure Synapse Analytics speaks TDS / SQL Server, so it runs
    // through the same tap-mssql as the sqlserver connector (env prefix
    // TAP_MSSQL_*). `schemas` defaults to `dbo` at the connect route.
    const schemas = (creds.schemas ?? "dbo")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      TAP_MSSQL_HOST: creds.host,
      TAP_MSSQL_PORT: creds.port,
      TAP_MSSQL_USER: creds.user,
      TAP_MSSQL_PASSWORD: creds.password,
      TAP_MSSQL_DATABASE: creds.database,
      TAP_MSSQL_FILTER_SCHEMAS: JSON.stringify(schemas),
    };
  },

  bigquery: (creds) => {
    // Reads the CUSTOMER's BigQuery (not ours). The tap only accepts a
    // credentials FILE PATH, so entrypoint.sh writes the SA-key JSON to
    // disk and sets TAP_BIGQUERY_CREDENTIALS_PATH itself — here we just
    // pass the raw JSON through. `datasets` (comma-separated) maps to
    // filter_schemas; blank means all datasets.
    const datasets = (creds.datasets ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const env: Record<string, string> = {
      TAP_BIGQUERY_PROJECT_ID: creds.project_id,
      TAP_BIGQUERY_CREDENTIALS_JSON: creds.credentials_json,
    };
    // Only set the filter when the customer scoped to specific datasets;
    // otherwise leave it unset so the tap discovers all of them.
    if (datasets.length > 0) {
      env.TAP_BIGQUERY_FILTER_SCHEMAS = JSON.stringify(datasets);
    }
    return env;
  },

  stripe: (creds) => {
    const env: Record<string, string> = {
      TAP_STRIPE_CLIENT_SECRET: creds.api_key,
    };
    // Only set start date if connect route stored one — otherwise the
    // entrypoint defaults to 1y ago, which is the right behaviour for
    // first-time setups where the user didn't pick a date.
    if (creds.start_date) env.TAP_STRIPE_START_DATE = creds.start_date;
    return env;
  },

  shopify: (creds) => ({
    TAP_SHOPIFY_STORE: creds.store,
    TAP_SHOPIFY_ADMIN_API_KEY: creds.admin_api_key,
  }),

  hubspot: (creds) => {
    const env: Record<string, string> = {
      TAP_HUBSPOT_ACCESS_TOKEN: creds.access_token,
    };
    if (creds.start_date) env.TAP_HUBSPOT_START_DATE = creds.start_date;
    return env;
  },

  "google-ads": (creds) => {
    // Connector TYPE stays "google-ads" (hyphen) for backward compat
    // with existing Firestore docs, Cloud Run Job names, etc. — only
    // the underlying tap name + env var prefix changed when we
    // migrated from hotgluexyz/tap-google-ads to Matatika/tap-googleads
    // (the Meltano Hub renamed the tap; old name de-registered).
    // See LIVELI-124.
    const env: Record<string, string> = {
      TAP_GOOGLEADS_DEVELOPER_TOKEN: creds.developer_token,
      TAP_GOOGLEADS_CLIENT_ID: creds.client_id,
      TAP_GOOGLEADS_CLIENT_SECRET: creds.client_secret,
      TAP_GOOGLEADS_REFRESH_TOKEN: creds.refresh_token,
      TAP_GOOGLEADS_CUSTOMER_IDS: creds.customer_ids,
    };
    if (creds.login_customer_id) {
      env.TAP_GOOGLEADS_LOGIN_CUSTOMER_ID = creds.login_customer_id;
    }
    return env;
  },

  "facebook-ads": (creds) => ({
    TAP_FACEBOOK_ACCESS_TOKEN: creds.access_token,
    TAP_FACEBOOK_ACCOUNT_ID: creds.account_id,
  }),

  salesforce: (creds) => ({
    TAP_SALESFORCE_CLIENT_ID: creds.client_id,
    TAP_SALESFORCE_CLIENT_SECRET: creds.client_secret,
    TAP_SALESFORCE_REFRESH_TOKEN: creds.refresh_token,
    TAP_SALESFORCE_DOMAIN: creds.domain ?? "login",
  }),

  mailchimp: (creds) => ({
    TAP_MAILCHIMP_API_KEY: creds.api_key,
  }),

  klaviyo: (creds) => ({
    TAP_KLAVIYO_AUTH_TOKEN: creds.auth_token,
  }),

  intercom: (creds) => ({
    TAP_INTERCOM_ACCESS_TOKEN: creds.access_token,
  }),

  slack: (creds) => ({
    // tap-slack's config field is `api_key` (despite expecting a Slack
    // bot token, "xoxb-...") — see connectors/slack-to-bq/meltano.yml.
    TAP_SLACK_API_KEY: creds.api_key,
  }),

  github: (creds) => ({
    TAP_GITHUB_AUTH_TOKEN: creds.auth_token,
    // `repositories` is a JSON-array config field on tap-github. The
    // connect route stored it as a serialised string; pass through
    // verbatim — Meltano parses the env var as JSON when the schema
    // declares the field as an array.
    TAP_GITHUB_REPOSITORIES: creds.repositories,
  }),

  linear: (creds) => ({
    TAP_LINEAR_AUTH_TOKEN: creds.auth_token,
  }),

  // ── Batch B (LIVELI-128): API-key + identifier SaaS connectors ──

  mixpanel: (creds) => ({
    // tap-mixpanel uses HTTP Basic with the Project API Secret as the
    // username (no password). One field, one env var.
    TAP_MIXPANEL_API_SECRET: creds.api_secret,
  }),

  // amplitude — REMOVED in LIVELI-132 PR-merge cleanup. The singer-io
  // variant was de-registered from Meltano Hub, and the remaining
  // `airbyte` wrapper variant needs Docker-in-Docker which Cloud Run
  // Jobs can't provide. No suitable replacement tap exists today.
  // Tracked for follow-up under a fresh Linear ticket; re-add when we
  // either build a custom tap or a usable singer variant resurfaces.

  jira: (creds) => ({
    // tap-jira (MeltanoLabs variant) supports both OAuth and basic
    // auth; we only wire basic (email + API token), which is what the
    // wizard collects. Atlassian Cloud only — `domain` MUST be a
    // *.atlassian.net host (enforced at the connect route).
    TAP_JIRA_DOMAIN: creds.domain,
    TAP_JIRA_EMAIL: creds.email,
    TAP_JIRA_API_TOKEN: creds.api_token,
  }),

  zendesk: (creds) => ({
    // tap-zendesk (singer-io) — bare subdomain slug, not the full
    // host. The connect route's regex ensures we never store
    // "yourcompany.zendesk.com" by accident; if that drifts in here
    // the tap will hit https://yourcompany.zendesk.com.zendesk.com
    // and 4xx with a useless DNS error.
    TAP_ZENDESK_SUBDOMAIN: creds.subdomain,
    TAP_ZENDESK_EMAIL: creds.email,
    TAP_ZENDESK_API_TOKEN: creds.api_token,
  }),

  // ── Batch C (LIVELI-132): OAuth refresh-token SaaS connectors ──
  //
  // These types ALSO need Liveli's OAuth app creds at sync time —
  // those come from `buildLiveliOauthEnv()` below, not from per-
  // customer `creds`. Sync route merges both env maps before
  // invoking the Cloud Run Job.

  ga4: (creds) => ({
    // tap-ga4 (MeltanoLabs SDK variant) uses nested config:
    //   oauth_credentials.{client_id, client_secret, refresh_token}
    //   property_id
    //
    // The dotted nested keys map to underscored env vars via Meltano's
    // standard flattening, but we ALSO declare them explicitly in
    // meltano.yml with $-substitution so the mapping doesn't depend
    // on Meltano version quirks.
    //
    // CLIENT_ID + CLIENT_SECRET intentionally NOT here — those come
    // from Liveli's google OAuth app via buildLiveliOauthEnv("ga4").
    TAP_GA4_OAUTH_CREDENTIALS_REFRESH_TOKEN: creds.refresh_token,
    TAP_GA4_OAUTH_CREDENTIALS_ACCESS_TOKEN: creds.access_token,
    TAP_GA4_PROPERTY_ID: creds.property_id,
  }),

  quickbooks: (creds) => ({
    // tap-quickbooks (hotgluexyz) flat config. `realmId` is the
    // QuickBooks Company ID — non-secret but identifying, captured
    // from the Intuit OAuth callback. `is_sandbox` toggles which
    // QuickBooks API host the tap hits (sandbox vs production).
    //
    // CLIENT_ID + CLIENT_SECRET come from Liveli's intuit OAuth app
    // via buildLiveliOauthEnv("quickbooks").
    TAP_QUICKBOOKS_REFRESH_TOKEN: creds.refresh_token,
    TAP_QUICKBOOKS_REALMID: creds.realmId,
    TAP_QUICKBOOKS_IS_SANDBOX: creds.is_sandbox ?? "false",
  }),

  // ── Batch D (LIVELI-133): API-key SaaS + MariaDB ──────────────────

  mariadb: (creds) => {
    // MariaDB is MySQL-wire-compatible → runs through tap-mysql (env
    // prefix TAP_MYSQL_*), same overwrite + FULL_TABLE contract as the
    // mysql connector. Same reserved-prefix gotcha: filter_dbs scopes
    // replication so the tap doesn't discover information_schema/sys.
    const dbs = (creds.filter_dbs ?? creds.database ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      TAP_MYSQL_HOST: creds.host,
      TAP_MYSQL_PORT: creds.port,
      TAP_MYSQL_USER: creds.user,
      TAP_MYSQL_PASSWORD: creds.password,
      TAP_MYSQL_DATABASE: creds.database,
      TAP_MYSQL_SSL: creds.ssl ?? "false",
      TAP_MYSQL_FILTER_DBS: JSON.stringify(dbs),
    };
  },

  pipedrive: (creds) => {
    const env: Record<string, string> = {
      TAP_PIPEDRIVE_API_TOKEN: creds.api_token,
    };
    if (creds.start_date) env.TAP_PIPEDRIVE_START_DATE = creds.start_date;
    return env;
  },

  square: (creds) => {
    const env: Record<string, string> = {
      TAP_SQUARE_ACCESS_TOKEN: creds.access_token,
      TAP_SQUARE_SANDBOX: creds.sandbox ?? "false",
    };
    if (creds.start_date) env.TAP_SQUARE_START_DATE = creds.start_date;
    return env;
  },

  woocommerce: (creds) => {
    const env: Record<string, string> = {
      TAP_WOOCOMMERCE_CONSUMER_KEY: creds.consumer_key,
      TAP_WOOCOMMERCE_CONSUMER_SECRET: creds.consumer_secret,
      TAP_WOOCOMMERCE_SITE_URL: creds.site_url,
    };
    if (creds.start_date) env.TAP_WOOCOMMERCE_START_DATE = creds.start_date;
    return env;
  },

  notion: (creds) => {
    const env: Record<string, string> = {
      TAP_NOTION_AUTH_TOKEN: creds.auth_token,
    };
    if (creds.start_date) env.TAP_NOTION_START_DATE = creds.start_date;
    return env;
  },

  freshdesk: (creds) => {
    // `domain` is the bare subdomain slug (the `<co>` in
    // <co>.freshdesk.com), enforced at the connect route.
    const env: Record<string, string> = {
      TAP_FRESHDESK_API_KEY: creds.api_key,
      TAP_FRESHDESK_DOMAIN: creds.domain,
    };
    if (creds.start_date) env.TAP_FRESHDESK_START_DATE = creds.start_date;
    return env;
  },

  chargebee: (creds) => {
    // `site` is the bare site name (the `<site>` in <site>.chargebee.com).
    // product_catalog MUST match the account's plan version ("1.0" vs
    // "2.0") or streams break — captured in the wizard, default "2.0".
    const env: Record<string, string> = {
      TAP_CHARGEBEE_API_KEY: creds.api_key,
      TAP_CHARGEBEE_SITE: creds.site,
      TAP_CHARGEBEE_PRODUCT_CATALOG: creds.product_catalog ?? "2.0",
    };
    if (creds.start_date) env.TAP_CHARGEBEE_START_DATE = creds.start_date;
    return env;
  },

  activecampaign: (creds) => {
    // `api_url` is the per-account API host (https://<account>.api-us1.com),
    // shown under Settings → Developer.
    const env: Record<string, string> = {
      TAP_ACTIVECAMPAIGN_API_TOKEN: creds.api_token,
      TAP_ACTIVECAMPAIGN_API_URL: creds.api_url,
    };
    if (creds.start_date) env.TAP_ACTIVECAMPAIGN_START_DATE = creds.start_date;
    return env;
  },

  bigcommerce: (creds) => {
    const env: Record<string, string> = {
      TAP_BIGCOMMERCE_CLIENT_ID: creds.client_id,
      TAP_BIGCOMMERCE_ACCESS_TOKEN: creds.access_token,
      TAP_BIGCOMMERCE_STORE_HASH: creds.store_hash,
    };
    if (creds.start_date) env.TAP_BIGCOMMERCE_START_DATE = creds.start_date;
    return env;
  },

  // ── Batch E (LIVELI-134): more DB + SaaS connectors ───────────────
  // DB connectors (mongodb/snowflake/oracle) run the raw-DB archetype:
  // overwrite + FULL_TABLE, no replicationConfig/excludedStreams (that
  // machinery is postgres-only). SaaS connectors run upsert.

  mongodb: (creds) => ({
    // tap-mongodb takes the full connection URI (mongodb:// or
    // mongodb+srv://) — Meltano flattens the `mongodb_connection_string`
    // setting to TAP_MONGODB_MONGODB_CONNECTION_STRING.
    TAP_MONGODB_MONGODB_CONNECTION_STRING: creds.connection_string,
    TAP_MONGODB_DATABASE: creds.database,
  }),

  snowflake: (creds, options) => {
    // tap-snowflake (meltanolabs). `warehouse` is required for the tap to
    // run queries. NOTE: this variant has NO `filter_schemas` setting —
    // discovery is scoped via the `tables` setting (dotted SCHEMA.TABLE
    // list), which we populate from connect-time introspection. The tap
    // auto-excludes INFORMATION_SCHEMA.
    const env: Record<string, string> = {
      TAP_SNOWFLAKE_ACCOUNT: creds.account,
      TAP_SNOWFLAKE_USER: creds.user,
      TAP_SNOWFLAKE_PASSWORD: creds.password,
      TAP_SNOWFLAKE_DATABASE: creds.database,
      TAP_SNOWFLAKE_WAREHOUSE: creds.warehouse,
    };
    // Scope discovery to exactly the introspected tables.
    if (options?.tables && options.tables.length > 0) {
      env.TAP_SNOWFLAKE_TABLES = JSON.stringify(options.tables);
    }
    // Per-stream tap replication metadata (INCREMENTAL/FULL_TABLE + key).
    if (options?.replicationConfig) {
      env.LIVELI_REPLICATION_CONFIG = JSON.stringify(options.replicationConfig);
    }
    // Per-stream loader-mode routing. PK'd tables MERGE (upsert); no-PK,
    // no-bookmark tables atomically replace (overwrite); everything else
    // appends (z3z1ma default). entrypoint.sh writes these into the
    // loader config as fnmatch pattern lists.
    if (options?.upsertStreams && options.upsertStreams.length > 0) {
      env.LIVELI_UPSERT_STREAMS = JSON.stringify(options.upsertStreams);
    }
    if (options?.overwriteStreams && options.overwriteStreams.length > 0) {
      env.LIVELI_OVERWRITE_STREAMS = JSON.stringify(options.overwriteStreams);
    }
    return env;
  },

  oracle: (creds, options) => {
    // pipelinewise-tap-oracle in `thin` mode (set in meltano.yml — no
    // Instant Client). filter_schemas scopes discovery; Oracle exposes
    // SYS/SYSTEM/etc. that we never want to replicate.
    //
    // NOTE: this tap reads filter_schemas as a COMMA-SEPARATED STRING
    // (`.split(',')`), NOT a JSON array like meltanolabs tap-postgres.
    // Passing JSON.stringify here would feed the tap a literal "[...]"
    // string and break discovery.
    const schemas = (creds.schemas ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const env: Record<string, string> = {
      TAP_ORACLE_HOST: creds.host,
      TAP_ORACLE_PORT: creds.port,
      TAP_ORACLE_USER: creds.user,
      TAP_ORACLE_PASSWORD: creds.password,
      TAP_ORACLE_SERVICE_NAME: creds.service_name,
    };
    if (schemas.length > 0) {
      env.TAP_ORACLE_FILTER_SCHEMAS = schemas.join(",");
    }
    // Per-stream replication metadata + no-PK exclusions from connect-time
    // introspection (lib/oracle-introspection.ts). Same mechanism as
    // postgres: entrypoint.sh merges these into meltano.yml. Loader runs
    // upsert: true, so excluded (no-PK) streams must be filtered out.
    if (options?.replicationConfig) {
      env.LIVELI_REPLICATION_CONFIG = JSON.stringify(options.replicationConfig);
    }
    if (options?.excludedStreams && options.excludedStreams.length > 0) {
      env.LIVELI_EXCLUDED_STREAMS = JSON.stringify(options.excludedStreams);
    }
    return env;
  },

  paypal: (creds) => {
    const env: Record<string, string> = {
      TAP_PAYPAL_CLIENT_ID: creds.client_id,
      TAP_PAYPAL_SECRET: creds.secret,
      TAP_PAYPAL_SANDBOX: creds.sandbox ?? "false",
    };
    if (creds.start_date) env.TAP_PAYPAL_START_DATE = creds.start_date;
    return env;
  },

  magento: (creds) => {
    const env: Record<string, string> = {
      TAP_MAGENTO_STORE_URL: creds.store_url,
      TAP_MAGENTO_ACCESS_TOKEN: creds.access_token,
    };
    if (creds.start_date) env.TAP_MAGENTO_START_DATE = creds.start_date;
    return env;
  },

  "zendesk-sell": (creds) => ({
    // Zendesk Sell (CRM) — distinct from the zendesk (Support) connector.
    // device_uuid is a stable client identifier for the Sync API
    // handshake, generated at the connect route.
    TAP_ZENDESK_SELL_ACCESS_TOKEN: creds.access_token,
    TAP_ZENDESK_SELL_DEVICE_UUID: creds.device_uuid,
  }),

  close: (creds) => {
    // tap-closeio — env prefix is TAP_CLOSEIO_* (tap's internal name).
    const env: Record<string, string> = {
      TAP_CLOSEIO_API_KEY: creds.api_key,
    };
    if (creds.start_date) env.TAP_CLOSEIO_START_DATE = creds.start_date;
    return env;
  },

  "tiktok-ads": (creds) => {
    const env: Record<string, string> = {
      TAP_TIKTOK_ACCESS_TOKEN: creds.access_token,
      TAP_TIKTOK_ADVERTISER_ID: creds.advertiser_id,
    };
    if (creds.start_date) env.TAP_TIKTOK_START_DATE = creds.start_date;
    return env;
  },

  segment: (creds) => {
    const env: Record<string, string> = {
      TAP_SEGMENT_API_TOKEN: creds.api_token,
    };
    if (creds.start_date) env.TAP_SEGMENT_START_DATE = creds.start_date;
    return env;
  },

  "sage-intacct": (creds) => {
    // Two credential layers: sender (app-level) + user (customer login).
    const env: Record<string, string> = {
      TAP_INTACCT_COMPANY_ID: creds.company_id,
      TAP_INTACCT_SENDER_ID: creds.sender_id,
      TAP_INTACCT_SENDER_PASSWORD: creds.sender_password,
      TAP_INTACCT_USER_ID: creds.user_id,
      TAP_INTACCT_USER_PASSWORD: creds.user_password,
    };
    if (creds.start_date) env.TAP_INTACCT_START_DATE = creds.start_date;
    return env;
  },
};

/**
 * Build the TAP_* env vars for a connector run. Throws
 * UnsupportedConnectorTypeError if the type isn't wired yet — caller
 * should map that to a 400 response.
 *
 * `options` carries non-credential per-connector data the builder needs
 * to know about (e.g. postgres' auto-detected replication config). The
 * sync routes read these out of the Firestore connector doc and pass
 * them through; they're NOT in Secret Manager.
 */
export function buildTapEnv(
  type: string,
  creds: Creds,
  options?: BuildTapEnvOptions
): Record<string, string> {
  const builder = TAP_ENV_BUILDERS[type];
  if (!builder) throw new UnsupportedConnectorTypeError(type);
  return builder(creds, options);
}

/**
 * Per-connector-type map from Liveli's OAuth app creds to the env vars
 * the tap expects. Returns {} for connector types that don't need
 * Liveli-app creds (the API-key Batch A/B connectors).
 *
 * Async because credentials are fetched from Secret Manager. Cached
 * in-process by `getLiveliAppCreds()` so the steady-state cost is one
 * Secret Manager call per (provider, cold start).
 *
 * Why this is separate from buildTapEnv: the customer's refresh_token
 * is tenant-scoped (lives in the per-connector secret payload), but
 * Liveli's client_id + client_secret are workspace-agnostic — they're
 * Liveli's OAuth app credentials, the same across all customers.
 * Mixing them into the per-connector secret would (a) duplicate
 * the same bytes across every customer's secret, and (b) make
 * rotation a horror (we'd have to re-write every connector secret).
 * Keeping them separate means rotation is `gcloud secrets versions
 * add liveli-oauth-google-client-secret ...` and done.
 */
export async function buildLiveliOauthEnv(
  type: string
): Promise<Record<string, string>> {
  // Dynamic import to keep the OAuth lib out of the connect-route +
  // sync-route initial import cost for non-OAuth connectors. The
  // OAuth code path pulls in Buffer-based HMAC + Secret Manager
  // helpers we don't need for postgres/mysql/etc.
  const { getLiveliAppCreds } = await import("@/lib/oauth/liveli-app-creds");

  if (type === "ga4") {
    const { clientId, clientSecret } = await getLiveliAppCreds("google");
    return {
      TAP_GA4_OAUTH_CREDENTIALS_CLIENT_ID: clientId,
      TAP_GA4_OAUTH_CREDENTIALS_CLIENT_SECRET: clientSecret,
    };
  }
  if (type === "quickbooks") {
    const { clientId, clientSecret } = await getLiveliAppCreds("intuit");
    return {
      TAP_QUICKBOOKS_CLIENT_ID: clientId,
      TAP_QUICKBOOKS_CLIENT_SECRET: clientSecret,
    };
  }
  return {};
}
