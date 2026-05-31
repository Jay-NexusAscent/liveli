import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Freshdesk auth = API key + the account subdomain. tap-freshdesk wants
 * the bare subdomain slug (the `<co>` in <co>.freshdesk.com), so the
 * wizard strips `.freshdesk.com` client-side; we re-validate the shape.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Freshdesk"),
  domain: z
    .string()
    .min(1)
    .max(63)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Domain must be the slug from yourco.freshdesk.com (lowercase letters, digits, hyphens)"
    ),
  apiKey: z.string().min(1).max(512),
  startDate: z.string().datetime().optional(),
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
      type: "freshdesk",
      name: body.name,
      ctx,
      secretPayload: {
        api_key: body.apiKey,
        domain: body.domain,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {
        domain: body.domain,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Freshdesk connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("freshdesk", step.current, err, [
      body.apiKey,
    ]);
    console.error("[freshdesk/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
