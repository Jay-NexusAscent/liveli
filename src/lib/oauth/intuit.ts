/**
 * Intuit OAuth 2.0 provider config (for QuickBooks Online).
 *
 * Key Intuit quirks vs the textbook OAuth dance:
 *   - The token endpoint requires HTTP Basic auth with the Liveli app
 *     credentials, NOT body-encoded `client_id`/`client_secret`.
 *     (Their docs are explicit but every other OAuth provider I've
 *     wired uses the body-encoded form, so easy mistake.)
 *   - The callback URL carries an extra `realmId` query param — this
 *     is the QuickBooks Company ID and is REQUIRED for every
 *     subsequent API call. We persist it into the connector's secret
 *     payload so the tap can read it at sync time.
 *   - One Liveli Intuit app talks to both customer-sandbox and
 *     customer-production. The `is_sandbox` flag the customer toggles
 *     in the wizard controls which QuickBooks API endpoint the tap
 *     hits (sandbox-quickbooks.api.intuit.com vs the prod host), NOT
 *     which OAuth client we use. So `is_sandbox` lives in the
 *     connector's per-customer config, not in OAuth-layer state.
 *
 * Scopes: `com.intuit.quickbooks.accounting` covers the QuickBooks
 * Online Accounting API (which is what tap-quickbooks uses). NOT to be
 * confused with `com.intuit.quickbooks.payment` (payments — separate
 * production review process).
 */

import type {
  OAuthConnectorType,
  OAuthTokenSet,
} from "@/lib/oauth/types";
import { getLiveliAppCreds } from "@/lib/oauth/liveli-app-creds";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const SCOPES: Record<Extract<OAuthConnectorType, "quickbooks">, string[]> = {
  quickbooks: ["com.intuit.quickbooks.accounting"],
};

export function intuitScopesFor(connectorType: OAuthConnectorType): string[] {
  if (connectorType === "quickbooks") return SCOPES.quickbooks;
  throw new Error(
    `Intuit OAuth doesn't support connector type "${connectorType}"`
  );
}

/**
 * Build Intuit's auth URL. Note `response_type=code` and the lack of
 * `access_type=offline` — Intuit always returns a refresh token for
 * the QuickBooks scope, no incantation required.
 */
export async function intuitBuildAuthUrl(params: {
  state: string;
  scopes: string[];
  redirectUri: string;
}): Promise<string> {
  const { clientId } = await getLiveliAppCreds("intuit");
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  return url.toString();
}

/**
 * Exchange Intuit's authorization code for tokens. Uses HTTP Basic
 * auth (client_id:client_secret) — see file header for why.
 */
export async function intuitExchangeCode(params: {
  code: string;
  redirectUri: string;
}): Promise<OAuthTokenSet> {
  const { clientId, clientSecret } = await getLiveliAppCreds("intuit");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Intuit token exchange failed (HTTP ${res.status}): ${text.slice(0, 500)}`
    );
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error("Intuit token response missing access_token");
  }
  if (!data.refresh_token) {
    // Unlike Google, Intuit always returns a refresh_token for the
    // accounting scope. Missing here means something's seriously off
    // (sandbox/prod env confusion, app deauthorized) — hard error.
    throw new Error("Intuit did not return a refresh_token");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
    scope: SCOPES.quickbooks.join(" "), // Intuit doesn't echo scope; assume granted = requested
  };
}

/**
 * Pull `realmId` out of the callback URL. Intuit appends this to the
 * redirect URI as `?code=...&state=...&realmId=<company_id>`. The
 * realmId is non-secret but identifying — the QuickBooks Company ID.
 * Required for every subsequent API call, so we persist it into the
 * connector's secret payload alongside the refresh_token.
 *
 * Throws if realmId is missing. Without it the connector can't
 * sync anything, so refuse to create rather than silently fail later.
 */
export function intuitParseCallbackExtras(
  searchParams: URLSearchParams
): Record<string, string> {
  const realmId = searchParams.get("realmId");
  if (!realmId) {
    throw new Error(
      "Intuit callback missing realmId — the QuickBooks Company ID. " +
        "This usually means the customer cancelled mid-flow or selected " +
        "a non-QuickBooks Intuit product. Retry the connection."
    );
  }
  return { realmId };
}
