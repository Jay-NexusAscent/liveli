/**
 * Google OAuth 2.0 provider config.
 *
 * Endpoints + scope map for the Liveli-app-as-OAuth-client flow with
 * Google. The auth URL is built per-request (state + scopes vary);
 * the token endpoint is a single POST.
 *
 * Refresh-token behaviour notes (critical, easy to get wrong):
 *   - `access_type=offline` is REQUIRED — without it, Google returns
 *     only a short-lived access_token (~1h) and no refresh_token. The
 *     connector would die after first sync.
 *   - `prompt=consent` is REQUIRED on first-time setup AND on re-auth.
 *     Google only emits a refresh_token if the user is shown the
 *     consent screen this turn. If we omit `prompt=consent` and the
 *     user has previously consented to the Liveli app, Google "trusts"
 *     them and skips the screen — which also skips the refresh_token.
 *     Better to always show consent than to silently break on re-auth.
 *
 * Scope rationale per connector type:
 *   - ga4: `analytics.readonly` for the Data API, `userinfo.email` to
 *     display the connected account on the connector card subtitle.
 *     `analytics.readonly` is a SENSITIVE scope — Google caps unverified
 *     apps at 100 test users. Liveli's email allowlist (LIVELI-69) is the
 *     interim defence; verification submission is a launch blocker.
 */

import type {
  OAuthConnectorType,
  OAuthStateClaims,
  OAuthTokenSet,
} from "@/lib/oauth/types";
import { getLiveliAppCreds } from "@/lib/oauth/liveli-app-creds";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Scopes Liveli requests per connector type. Keep narrow — Google's
 * verification process gets stricter with each additional sensitive
 * scope. `userinfo.email` is non-sensitive; `analytics.readonly` is
 * sensitive but unrestricted.
 */
const SCOPES: Record<Extract<OAuthConnectorType, "ga4">, string[]> = {
  ga4: [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
};

export function googleScopesFor(connectorType: OAuthConnectorType): string[] {
  if (connectorType === "ga4") return SCOPES.ga4;
  throw new Error(
    `Google OAuth doesn't support connector type "${connectorType}"`
  );
}

/**
 * Build the redirect URL the customer's browser should hit to start
 * the Google consent screen.
 *
 * `redirectUri` MUST match one of the URIs registered in Google Cloud
 * Console for Liveli's OAuth client. Mismatches surface as a 400 from
 * Google before consent — annoying because the error renders on
 * Google's domain with no obvious "fix this in your config" message.
 */
export async function googleBuildAuthUrl(params: {
  state: string;
  scopes: string[];
  redirectUri: string;
  /** Pre-fill the account picker if we know the user's email — small
   * UX win, harmless if blank. */
  loginHint?: string;
}): Promise<string> {
  const { clientId } = await getLiveliAppCreds("google");
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  // offline + consent: the refresh-token incantation. See file header.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  // include_granted_scopes lets us "add to" the user's existing
  // consent if they've granted other Liveli connectors previously,
  // rather than starting over with a blank slate.
  url.searchParams.set("include_granted_scopes", "true");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

/**
 * Exchange the authorization code from the callback for an
 * access + refresh token pair.
 *
 * `redirectUri` MUST be byte-identical to the one used in the auth URL
 * (Google validates the exchange against the redirect URI as part of
 * PKCE-adjacent CSRF defence even when PKCE isn't enabled).
 */
export async function googleExchangeCode(params: {
  code: string;
  redirectUri: string;
}): Promise<OAuthTokenSet> {
  const { clientId, clientSecret } = await getLiveliAppCreds("google");

  const body = new URLSearchParams({
    code: params.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Google's error response shape: { error, error_description, ... }.
    // Surface error_description verbatim — it's already user-meaningful
    // and the wizard will display it.
    const text = await res.text().catch(() => "");
    throw new Error(
      `Google token exchange failed (HTTP ${res.status}): ${text.slice(0, 500)}`
    );
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error("Google token response missing access_token");
  }
  // Refresh token may be absent if `prompt=consent` was somehow
  // dropped — treat as a hard error rather than persisting a connector
  // that'll die after ~1 hour. See file header for the underlying
  // Google quirk.
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. This usually means " +
        "`prompt=consent` was missing on the auth URL. The connector " +
        "would die after the access token expires (~1h), so refusing to " +
        "create it. Try again."
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
    scope: data.scope ?? "",
  };
}

/**
 * Convenience for the start route — extract the (clientId, workspaceId,
 * userId, connectorType, name, syncFrequency, autoSync, extras) tuple
 * the workspace-context-checked claims need, given the workspace ctx +
 * the wizard's POST body.
 */
export function googleStateClaimsFrom(input: {
  ctx: { clientId: string; workspaceId: string; userId: string };
  connectorType: OAuthConnectorType;
  name: string;
  syncFrequency: OAuthStateClaims["syncFrequency"];
  autoSync: boolean;
  extras: Record<string, string>;
}): Omit<OAuthStateClaims, "nonce" | "expiresAt"> {
  return {
    clientId: input.ctx.clientId,
    workspaceId: input.ctx.workspaceId,
    userId: input.ctx.userId,
    connectorType: input.connectorType,
    name: input.name,
    syncFrequency: input.syncFrequency,
    autoSync: input.autoSync,
    extras: input.extras,
  };
}
