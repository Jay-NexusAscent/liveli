/**
 * OAuth callback route — handles the redirect from the provider after
 * user consent.
 *
 * GET /api/auth/oauth/[provider]/callback?code=...&state=...[&realmId=...]
 *
 * Provider redirects the customer's BROWSER to this URL. The browser
 * carries Clerk's session cookie (top-level navigation, SameSite=Lax
 * permits it), so `requireWorkspaceContext()` returns the same tenant
 * context the /start route ran under — assuming the user hasn't
 * switched orgs in another tab mid-flow. The state-claims cross-check
 * catches that case.
 *
 * Flow:
 *   1. Verify state signature + expiry → claims
 *   2. Cross-check claims.{clientId, workspaceId, userId} vs current ctx
 *      (user could have switched org since /start; refuse rather than
 *       bind to wrong tenant)
 *   3. Exchange code for tokens
 *   4. Parse provider extras (Intuit's realmId)
 *   5. Compose secretPayload and call provisionConnector
 *   6. Optionally trigger initial sync
 *   7. Redirect to /connections?connected=<id> or ?error=<reason>
 *
 * All error paths redirect back to /connections with an `?error=`
 * querystring — the page handles displaying it. We don't render
 * errors here directly because this is an API route, not a page.
 */

import { NextResponse } from "next/server";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import {
  getProvider,
  isKnownProvider,
} from "@/lib/oauth/providers";
import {
  OAuthStateError,
  verifyOAuthState,
} from "@/lib/oauth/state";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { runConnectorJob } from "@/lib/cloud-run";
import { cloudComputeRegionForResidency } from "@/lib/gcp";
import { workspaceDoc } from "@/lib/firestore";
import { DEFAULT_BQ_LOCATION } from "@/lib/bigquery";
import { connectorsIn } from "@/lib/firestore";
import { readConnectorSecret } from "@/lib/secret-manager";
import { buildLiveliOauthEnv, buildTapEnv } from "@/lib/connector-env";
import { FieldValue } from "@google-cloud/firestore";
import { gcp } from "@/lib/gcp";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  req: Request,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await context.params;
  // Derive origin from forwarded headers, NOT from req.url — see the
  // matching comment in start/route.ts for the rationale. The
  // redirectUri we compute here MUST be byte-identical to the one
  // start/route.ts used; both providers verify this on token exchange.
  const fwdHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const origin = fwdHost ? `${proto}://${fwdHost}` : new URL(req.url).origin;
  const connectionsUrl = `${origin}/connections`;

  // Helper: redirect to /connections with an error querystring.
  // Logged server-side too — the customer never sees the technical
  // detail, but operators do.
  const redirectError = (
    code: string,
    technicalMessage: string,
    httpLog: Record<string, unknown> = {}
  ) => {
    console.error(`[oauth/callback] ${code}`, { provider: providerId, technicalMessage, ...httpLog });
    const u = new URL(connectionsUrl);
    u.searchParams.set("error", `oauth_${code}`);
    return NextResponse.redirect(u, 302);
  };

  // ── 0. Sanity: known provider, no provider-error query ──────────
  if (!isKnownProvider(providerId)) {
    return redirectError("unknown_provider", `Unknown provider "${providerId}"`);
  }
  const provider = getProvider(providerId);

  const params = new URL(req.url).searchParams;
  const providerError = params.get("error");
  if (providerError) {
    // Customer denied consent or provider rejected — surface their
    // reason. `error_description` may be set on the URL too.
    const desc = params.get("error_description") ?? "";
    return redirectError(
      "provider_error",
      `${providerError}: ${desc.slice(0, 300)}`
    );
  }

  // ── 1. Verify state ─────────────────────────────────────────────
  const stateToken = params.get("state");
  const code = params.get("code");
  if (!stateToken || !code) {
    return redirectError(
      "missing_state_or_code",
      `state=${!!stateToken} code=${!!code}`
    );
  }

  let claims;
  try {
    claims = await verifyOAuthState(stateToken);
  } catch (err) {
    if (err instanceof OAuthStateError) {
      return redirectError("invalid_state", err.message);
    }
    throw err;
  }

  // ── 2. Auth + tenant cross-check ────────────────────────────────
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Session went stale during the OAuth dance — push them through
      // sign-in. Once authed, they can retry; the provider's recent-
      // consent will skip the consent screen (modulo `prompt=consent`
      // on Google).
      const signIn = new URL(`${origin}/sign-in`);
      signIn.searchParams.set("redirect_url", "/connections");
      return NextResponse.redirect(signIn, 302);
    }
    throw err;
  }

  if (
    claims.clientId !== ctx.clientId ||
    claims.workspaceId !== ctx.workspaceId ||
    claims.userId !== ctx.userId
  ) {
    // User switched org / workspace / signed in as someone else
    // between /start and /callback. The state was issued for a
    // different tenant; binding it here would be a workspace-boundary
    // violation.
    return redirectError(
      "tenant_mismatch",
      `claims=${claims.clientId}/${claims.workspaceId}/${claims.userId} ctx=${ctx.clientId}/${ctx.workspaceId}/${ctx.userId}`
    );
  }

  // ── 3. Exchange code for tokens ─────────────────────────────────
  // Redirect URI MUST be byte-identical to what we used in /start —
  // both providers validate this as part of the exchange.
  const redirectUri = `${origin}/api/auth/oauth/${providerId}/callback`;

  let tokens;
  let providerExtras: Record<string, string> = {};
  try {
    [tokens, providerExtras] = await Promise.all([
      provider.exchangeCode({ code, redirectUri }),
      // parseCallbackExtras is sync; Promise.all is fine because it's
      // about ordering, not parallelism. Inlining for symmetry with
      // future providers that might do async lookups here.
      Promise.resolve(provider.parseCallbackExtras(params)),
    ]);
  } catch (err) {
    return redirectError(
      "token_exchange_failed",
      err instanceof Error ? err.message : String(err)
    );
  }

  // ── 4. Compose secret payload ───────────────────────────────────
  // Per-connector secret holds CUSTOMER data:
  //   - refresh_token (rotates if revoked / re-consented; long-lived)
  //   - access_token (~1h; tap will refresh from refresh_token + Liveli
  //                   app creds at sync time)
  //   - property_id / realmId / etc. — connector identifiers
  // Liveli's client_id+secret are NOT here — they're injected at sync
  // time via buildLiveliOauthEnv() (workspace-agnostic).
  const refreshToken = tokens.refreshToken;
  if (!refreshToken) {
    return redirectError(
      "no_refresh_token",
      "provider didn't return a refresh_token"
    );
  }

  const secretPayload: Record<string, string> = {
    refresh_token: refreshToken,
    access_token: tokens.accessToken,
    ...claims.extras,
    ...providerExtras,
  };

  // ── 5. Provision the connector ──────────────────────────────────
  let connectorId: string;
  try {
    const result = await provisionConnector({
      type: claims.connectorType,
      name: claims.name,
      ctx,
      secretPayload,
      // firestoreFields holds non-secret display data. property_id and
      // realmId aren't secret (they're customer-identifying but
      // unprivileged) — surface them so the connector card subtitle
      // can say "Liveli · GA4 property 123456789".
      firestoreFields: {
        ...claims.extras,
        ...providerExtras,
        // Track the OAuth provider so the edit modal can show
        // "Reconnect with Google" CTAs etc. (LIVELI-133 retrofit
        // will use this).
        oauthProvider: providerId,
      },
      syncFrequency: claims.syncFrequency,
    });
    connectorId = result.connectorId;
  } catch (err) {
    // Sensitive values to redact from any error envelope written to
    // logs. The access + refresh tokens are the real secrets.
    const envelope = connectErrorEnvelope(claims.connectorType, "provisionConnector", err, [
      refreshToken,
      tokens.accessToken,
    ]);
    console.error("[oauth/callback] provisionConnector failed", envelope);
    return redirectError(
      "provision_failed",
      err instanceof Error ? err.message : String(err)
    );
  }

  // ── 6. Optional initial sync ────────────────────────────────────
  // Best-effort: if it fails the connector still exists (customer can
  // click "Sync now" manually). Match the autoSync UX from Batch A/B
  // wizards.
  if (claims.autoSync) {
    try {
      await triggerFirstSync({ ctx, connectorId, connectorType: claims.connectorType });
    } catch (err) {
      // Don't fail the redirect — connector exists and is configured;
      // missing-first-sync is a soft failure surfaced as the
      // connector card's lastError on the next refresh.
      console.error("[oauth/callback] initial sync failed (non-blocking)", {
        connectorId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 7. Success redirect ─────────────────────────────────────────
  const u = new URL(connectionsUrl);
  u.searchParams.set("connected", connectorId);
  return NextResponse.redirect(u, 302);
}

/**
 * Trigger the first sync run for a freshly-provisioned OAuth
 * connector. Mirrors the manual sync route's flow (build env,
 * runConnectorJob, write status="syncing") so the customer sees
 * the progress bar light up on return to /connections.
 *
 * Kept inline rather than DRYed with sync/route.ts because the sync
 * route has Clerk-checked request-context plumbing that doesn't
 * apply here — we already have ctx from the callback's auth check.
 */
async function triggerFirstSync(args: {
  ctx: { clientId: string; workspaceId: string };
  connectorId: string;
  connectorType: string;
}) {
  const { ctx, connectorId, connectorType } = args;

  const ref = connectorsIn(ctx.clientId, ctx.workspaceId).doc(connectorId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("connector vanished between create and sync");
  const data = snap.data() as { bqDataset: string; bqLocation?: "EU" | "US" };

  const location = data.bqLocation ?? DEFAULT_BQ_LOCATION;
  if (!data.bqLocation) {
    const wsSnap = await workspaceDoc(ctx.clientId, ctx.workspaceId).get();
    const wsLoc = (wsSnap.data() as { bqLocation?: "EU" | "US" } | undefined)?.bqLocation;
    if (wsLoc) {
      // overwrite our local variable, not the connector doc — the
      // connector doc was authoritative at provision time
    }
  }
  const { region, suffix } = cloudComputeRegionForResidency(
    location === "US" || location === "EU" ? location : "EU"
  );

  const creds = await readConnectorSecret(ctx.clientId, connectorId);

  const env: Record<string, string> = {
    WORKSPACE_ID: ctx.clientId,
    CLIENT_ID: ctx.clientId,
    LIVELI_WORKSPACE_ID: ctx.workspaceId,
    CONNECTOR_ID: connectorId,
    TARGET_BIGQUERY_PROJECT: gcp.projectId,
    TARGET_BIGQUERY_DATASET: data.bqDataset,
    TARGET_BIGQUERY_LOCATION: location,
    MELTANO_STATE_BACKEND_URI: `gs://liveli-meltano-state-${suffix}`,
  };

  Object.assign(env, await buildLiveliOauthEnv(connectorType));
  Object.assign(env, buildTapEnv(connectorType, creds));

  const jobName = `connector-${connectorType}-to-bq-${suffix}`;
  const r = await runConnectorJob(jobName, region, env);

  await ref.update({
    status: "syncing",
    lastExecutionName: r.executionName,
    lastSyncAttemptAt: FieldValue.serverTimestamp(),
  });
}
