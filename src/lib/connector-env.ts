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

  amplitude: (creds) => ({
    // tap-amplitude (singer-io) — both halves of the Basic-auth pair.
    // Deliberately NOT the default Airbyte wrapper variant: that one
    // needs Docker-in-Docker, which Cloud Run Jobs can't provide.
    TAP_AMPLITUDE_API_KEY: creds.api_key,
    TAP_AMPLITUDE_API_SECRET: creds.api_secret,
  }),

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
