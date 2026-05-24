/**
 * Liveli's OAuth app credentials per provider — workspace-agnostic.
 *
 * One Liveli app per provider talks to all customers' Google / Intuit
 * accounts. Customers never see these credentials; they ship as part
 * of the OAuth dance (start route mints the auth URL with Liveli's
 * client_id; callback exchanges the code with Liveli's client_secret).
 *
 * At sync time the Cloud Run Job needs Liveli's client_id + secret
 * AGAIN, because the tap mints a fresh access token from the
 * (Liveli client_id, Liveli client_secret, customer refresh_token)
 * triple. The sync route fetches these via `buildLiveliOauthEnv()`
 * (in connector-env.ts) and injects them as env vars on the Job run.
 *
 * Caching: in-process for the function lifetime. The credentials
 * literally never change between deploys — the secrets in Secret
 * Manager are tied to the Liveli OAuth app registration in
 * Google Cloud Console / Intuit Developer Portal, which is a manual
 * one-time setup. Even on rotation, Fluid Compute recycling picks up
 * the new values within minutes.
 *
 * Secret names (must match those created by Jay per LIVELI-132):
 *   - liveli-oauth-google-client-id
 *   - liveli-oauth-google-client-secret
 *   - liveli-oauth-intuit-client-id
 *   - liveli-oauth-intuit-client-secret
 */

import { readLiveliAppSecret } from "@/lib/secret-manager";
import type { OAuthProviderId } from "@/lib/oauth/types";

export interface LiveliAppCreds {
  clientId: string;
  clientSecret: string;
}

/**
 * Per-provider cache. Both halves are read at first access; if either
 * is missing we throw with a clear remediation message rather than
 * crashing the OAuth dance halfway through with a 4xx from the provider.
 */
const _cache = new Map<OAuthProviderId, LiveliAppCreds>();

export async function getLiveliAppCreds(
  provider: OAuthProviderId
): Promise<LiveliAppCreds> {
  const cached = _cache.get(provider);
  if (cached) return cached;

  const idSecretName = `liveli-oauth-${provider}-client-id`;
  const secretSecretName = `liveli-oauth-${provider}-client-secret`;

  let clientId: string;
  let clientSecret: string;
  try {
    [clientId, clientSecret] = await Promise.all([
      readLiveliAppSecret(idSecretName),
      readLiveliAppSecret(secretSecretName),
    ]);
  } catch (err) {
    // Re-throw with a more actionable message — the most likely cause
    // is "Jay hasn't run step 1 of LIVELI-132's manual setup yet" and
    // we want that clear in the error rather than a raw Secret Manager
    // NOT_FOUND.
    const code = (err as { code?: number })?.code;
    if (code === 5 || code === 7) {
      throw new MissingLiveliAppCredsError(provider, err);
    }
    throw err;
  }

  if (!clientId.trim() || !clientSecret.trim()) {
    throw new MissingLiveliAppCredsError(
      provider,
      new Error("Secret Manager entry is empty")
    );
  }

  const creds = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  _cache.set(provider, creds);
  return creds;
}

/**
 * Cache-bust — for tests, or for an admin endpoint that lets ops
 * force a re-read after key rotation without waiting for natural
 * function-instance recycling.
 */
export function clearLiveliAppCredsCache(provider?: OAuthProviderId): void {
  if (provider) _cache.delete(provider);
  else _cache.clear();
}

export class MissingLiveliAppCredsError extends Error {
  constructor(public provider: OAuthProviderId, public cause: unknown) {
    super(
      `Liveli OAuth app credentials for "${provider}" are not configured in Secret Manager. ` +
        `Expected secrets: liveli-oauth-${provider}-client-id and liveli-oauth-${provider}-client-secret. ` +
        `See LIVELI-132 for setup steps.`
    );
    this.name = "MissingLiveliAppCredsError";
  }
}
