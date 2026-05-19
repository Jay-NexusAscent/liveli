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
 */

export class UnsupportedConnectorTypeError extends Error {
  constructor(public readonly type: string) {
    super(`Sync not yet wired for connector type: ${type}`);
    this.name = "UnsupportedConnectorTypeError";
  }
}

type Creds = Record<string, string>;
type EnvBuilder = (creds: Creds) => Record<string, string>;

const TAP_ENV_BUILDERS: Record<string, EnvBuilder> = {
  postgres: (creds) => {
    // filter_schemas restricts tap-postgres to user schemas only —
    // without it the tap discovers pg_catalog + information_schema, and
    // target-bigquery crashes trying to create `information_schema__pg_*`
    // tables because BQ reserves the `information_schema` prefix.
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
    const env: Record<string, string> = {
      TAP_GOOGLE_ADS_DEVELOPER_TOKEN: creds.developer_token,
      TAP_GOOGLE_ADS_CLIENT_ID: creds.client_id,
      TAP_GOOGLE_ADS_CLIENT_SECRET: creds.client_secret,
      TAP_GOOGLE_ADS_REFRESH_TOKEN: creds.refresh_token,
      TAP_GOOGLE_ADS_CUSTOMER_IDS: creds.customer_ids,
    };
    if (creds.login_customer_id) {
      env.TAP_GOOGLE_ADS_LOGIN_CUSTOMER_ID = creds.login_customer_id;
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
};

/**
 * Build the TAP_* env vars for a connector run. Throws
 * UnsupportedConnectorTypeError if the type isn't wired yet — caller
 * should map that to a 400 response.
 */
export function buildTapEnv(type: string, creds: Creds): Record<string, string> {
  const builder = TAP_ENV_BUILDERS[type];
  if (!builder) throw new UnsupportedConnectorTypeError(type);
  return builder(creds);
}
