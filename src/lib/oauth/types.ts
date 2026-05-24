/**
 * Shared OAuth types for the Liveli OAuth integration layer.
 *
 * Provider-specific quirks (Intuit's realmId callback param, Google's
 * offline_access prompt, scope-per-connector-type maps) live in the
 * provider modules — keep this file narrow.
 */

/** OAuth providers Liveli integrates. Extend when adding e.g. "slack". */
export type OAuthProviderId = "google" | "intuit";

/**
 * Connector types the OAuth layer can provision. The provider start
 * route reads the `?type=` query param and dispatches scope selection
 * + downstream `provisionConnector({ type })` call off this.
 *
 * Each provider only supports a subset (Google → ga4 + future ga,
 * google-ads, google-sheets; Intuit → quickbooks). The provider's
 * `scopesFor(connectorType)` map enforces the constraint.
 */
export type OAuthConnectorType = "ga4" | "quickbooks";

/**
 * State claims that travel through the OAuth redirect dance.
 *
 * Signed as a single HMAC blob (see oauth/state.ts) and round-tripped
 * via the `state` query param. The provider's callback hands it back
 * verbatim; we verify the HMAC and trust the contents.
 *
 * SECURITY NOTE — every field here is in the trust boundary:
 *   - `clientId` / `workspaceId` decide which tenant the new connector
 *     binds to. Forge them → cross-tenant connector creation.
 *   - `userId` is who Firestore records as `createdBy`. Forge it → audit
 *     log lies about who connected the source.
 *   - `connectorType` decides which Cloud Run Job we provision against.
 *     Not a security concern, but a correctness one.
 *
 * Anti-replay: `nonce` (random 16 bytes) + `expiresAt` (unix ms,
 * default 10 min from issue). State is single-use in spirit but we
 * don't track used-nonces server-side — the 10-min expiry + HMAC
 * binding is the defence.
 */
export interface OAuthStateClaims {
  /** Clerk org / Liveli client ID. */
  clientId: string;
  /** Workspace ID under the client. */
  workspaceId: string;
  /** Clerk user ID — recorded as `createdBy` on the connector doc. */
  userId: string;
  /** Connector type to provision after token exchange. */
  connectorType: OAuthConnectorType;
  /** Friendly connector name the customer entered. */
  name: string;
  /** Sync frequency the customer picked. */
  syncFrequency: "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";
  /** Whether to kick off the first sync immediately after provisioning. */
  autoSync: boolean;
  /** Connector-specific extras (GA4 property_id, QB is_sandbox). */
  extras: Record<string, string>;
  /** Unix ms. State expires after this — re-issue + re-redirect required. */
  expiresAt: number;
  /** 16-byte random nonce, base64url. Defence in depth against replay. */
  nonce: string;
}

/**
 * Standard token response shape across providers. The provider's
 * `exchangeCode` normalises to this so callbacks don't need
 * provider-specific destructuring.
 *
 * Note: `refreshToken` is NULLABLE because some flows (Intuit when the
 * customer has previously consented and the app's already-trusted
 * mode) only return a fresh access token. We treat that as a hard
 * error in the callback — without a refresh token, the connector
 * can't survive past the access-token expiry (~1h Google, ~1h Intuit)
 * so there's no point persisting it.
 */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds the access token is valid for (typically 3600). */
  expiresIn: number;
  /** Granted scopes, space-separated. May differ from requested. */
  scope: string;
  /** Intuit hands the QB company ID back here. Google doesn't use it. */
  realmId?: string;
}
