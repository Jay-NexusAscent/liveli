import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Zendesk Support auth = subdomain + agent email + API token. Token Access
 * must be enabled in Admin Center → Apps and integrations → Zendesk API.
 * tap-zendesk wants the bare subdomain slug (not the full host), so the
 * wizard strips `.zendesk.com` client-side; we re-validate the shape here.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Zendesk"),
  subdomain: z
    .string()
    .min(1)
    .max(63)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Subdomain must be the slug from yourcompany.zendesk.com (lowercase letters, digits, hyphens)"
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
      type: "zendesk",
      name: body.name,
      ctx,
      secretPayload: {
        subdomain: body.subdomain,
        email: body.email,
        api_token: body.apiToken,
      },
      // Surface the subdomain so the card subtitle reads "Zendesk ·
      // yourcompany" — useful when multiple Zendesk Support tenants
      // are connected to the same workspace.
      firestoreFields: {
        subdomain: body.subdomain,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Zendesk connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("zendesk", step.current, err, [
      body.apiToken,
    ]);
    console.error("[zendesk/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
