/**
 * OAuth start route — kicks off the redirect dance.
 *
 * POST /api/auth/oauth/[provider]/start
 *
 * Auth: Clerk session cookie (requireWorkspaceContext). The dance is
 * tenant-scoped from the very first byte — anonymous flows are not
 * supported and would have nowhere to bind the resulting connector
 * anyway.
 *
 * Body:
 *   { connectorType, name, syncFrequency, autoSync, extras }
 *
 * Response: 200 { redirectUrl } — the wizard sets `window.location.href`.
 *
 * Why POST + JSON response rather than a 302 redirect: the wizard
 * needs to do upfront validation (property_id format, etc.) before
 * starting the dance, and a fetch() lets it surface JSON errors
 * inline. A direct 302 would force any errors to render as
 * /connections?error=foo querystrings, which is a worse UX.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import {
  getProvider,
  isKnownProvider,
  UnknownProviderError,
} from "@/lib/oauth/providers";
import { signOAuthState } from "@/lib/oauth/state";
import { googleStateClaimsFrom } from "@/lib/oauth/google";
import type { OAuthConnectorType } from "@/lib/oauth/types";
import { MissingLiveliAppCredsError } from "@/lib/oauth/liveli-app-creds";

export const runtime = "nodejs";
export const maxDuration = 15;

const Body = z.object({
  connectorType: z.enum(["ga4", "quickbooks"]),
  name: z.string().min(1).max(120),
  syncFrequency: z
    .enum(["5m", "15m", "30m", "1h", "6h", "12h", "24h"])
    .default("1h"),
  autoSync: z.boolean().default(true),
  /**
   * Connector-type-specific extras stashed in state and consumed in the
   * callback. Schema is intentionally loose at this layer — the
   * callback's downstream validation (provisionConnector / TAP_ENV)
   * is the proper enforcement point. Keep tight bounds on size to
   * prevent state-bloat / cookie-sized-headers issues.
   */
  extras: z.record(z.string(), z.string()).default({}),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider: providerId } = await context.params;

  // Auth + tenant context. We do this BEFORE provider lookup so an
  // unauthed user gets a 401 rather than a 404 (no information leak
  // about which providers we support).
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  if (!isKnownProvider(providerId)) {
    return NextResponse.json(
      { error: `Unknown OAuth provider "${providerId}"` },
      { status: 404 }
    );
  }
  const provider = getProvider(providerId);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  // Cross-check: does THIS provider support the requested connector
  // type? Wizard-level validation should catch this but defence in
  // depth — bad combos slip through if the wizard's enum drifts from
  // the provider's supportedTypes.
  if (!provider.supportedTypes.includes(body.connectorType)) {
    return NextResponse.json(
      {
        error: `Provider "${providerId}" doesn't support connector type "${body.connectorType}". Supported: ${provider.supportedTypes.join(", ")}`,
      },
      { status: 400 }
    );
  }

  // Redirect URI MUST match what's registered in the provider's app
  // console (Google Cloud Console / Intuit Developer Portal). We
  // derive from req.url so dev (localhost:3000) and prod (app.liveli.co.uk)
  // both work without env-var fiddling — but see the threat-model
  // comment on assertAllowedOrigin().
  const origin = new URL(req.url).origin;
  if (!assertAllowedOrigin(origin)) {
    return NextResponse.json(
      { error: "Request origin not in OAuth allowlist" },
      { status: 400 }
    );
  }
  const redirectUri = `${origin}/api/auth/oauth/${providerId}/callback`;

  try {
    const state = await signOAuthState(
      googleStateClaimsFrom({
        ctx,
        connectorType: body.connectorType as OAuthConnectorType,
        name: body.name,
        syncFrequency: body.syncFrequency,
        autoSync: body.autoSync,
        extras: body.extras,
      })
    );

    const redirectUrl = await provider.buildAuthUrl({
      state,
      scopes: provider.scopesFor(body.connectorType as OAuthConnectorType),
      redirectUri,
    });

    return NextResponse.json({ redirectUrl });
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof MissingLiveliAppCredsError) {
      // 503 not 500 — the request was valid, the SERVER isn't ready
      // because Jay hasn't completed step 1 of LIVELI-132's manual
      // setup. The error message is actionable (says exactly which
      // Secret Manager entries are missing).
      console.error("[oauth/start] missing Liveli app creds", {
        provider: providerId,
        msg: err.message,
      });
      return NextResponse.json(
        { error: err.message, errorCode: "OAUTH_NOT_CONFIGURED" },
        { status: 503 }
      );
    }
    console.error("[oauth/start] failed", {
      provider: providerId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: "Couldn't start the OAuth flow.",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

/**
 * Origin allowlist for OAuth flows. Per the threat-model comment
 * above, the actual defence against redirect-URI tampering is the
 * provider's strict allowlist in their app console — this is
 * belt-and-braces for the rare case where:
 *
 *   - An attacker spoofs Host/X-Forwarded-Host on a request from a
 *     trusted user's browser (e.g. via a vulnerable proxy)
 *   - AND somehow gets the provider's app config to accept their
 *     redirect URI
 *
 * Both ANDs are required for an actual exploit, so this is paranoia.
 * But the check is 5 lines + a comment so the cost is nothing.
 *
 * Allowlist sourced from `OAUTH_ALLOWED_ORIGINS` env var (comma-sep)
 * with sensible defaults for dev + the canonical prod host.
 */
function assertAllowedOrigin(origin: string): boolean {
  const envAllow = (process.env.OAUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = [
    "https://app.liveli.co.uk",
    "http://localhost:3000",
    "http://localhost:3001",
  ];
  return [...envAllow, ...defaults].includes(origin);
}
