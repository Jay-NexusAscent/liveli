import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Jira Cloud auth = Atlassian account email + API token (HTTP Basic).
 * The wizard normalises the domain to `<workspace>.atlassian.net` before
 * POST; we re-validate the shape here as defence-in-depth — the client
 * is untrusted, and an attacker who bypasses the wizard could otherwise
 * inject an arbitrary hostname into the tap config.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Jira"),
  // Atlassian site host, e.g. `yourcompany.atlassian.net`. We accept
  // only the canonical Atlassian-hosted form — self-hosted Jira Server /
  // Data Center would need a different tap config and isn't wired yet.
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/,
      "Jira domain must be a valid Atlassian site (e.g. yourcompany.atlassian.net)"
    ),
  email: z.string().email().max(254),
  apiToken: z.string().min(1).max(512),
  syncFrequency: z.enum(["5m", "15m", "30m", "1h", "6h", "12h", "24h"]).default("1h"),
});

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  const step = { current: "init" };
  try {
    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "jira",
      name: body.name,
      ctx,
      secretPayload: {
        // Domain isn't strictly a secret, but bundling it keeps the
        // env-builder simple (single-source lookup) and avoids a second
        // Firestore round trip on every sync. Same pattern as shopify's
        // store identifier.
        domain: body.domain,
        email: body.email,
        api_token: body.apiToken,
      },
      // Surface the site host in the connector card subtitle — helps
      // disambiguate when a workspace has multiple Jira sites connected.
      firestoreFields: {
        domain: body.domain,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Jira connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("jira", step.current, err, [
      body.apiToken,
    ]);
    console.error("[jira/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
