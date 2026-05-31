import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * ActiveCampaign auth = API token + the per-account API URL (shown under
 * Settings → Developer, looks like https://<account>.api-us1.com).
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("ActiveCampaign"),
  apiUrl: z
    .string()
    .url()
    .max(255)
    .regex(/\.api-[a-z0-9]+\.com\/?$/, "API URL looks like https://<account>.api-us1.com"),
  apiToken: z.string().min(1).max(512),
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
      type: "activecampaign",
      name: body.name,
      ctx,
      secretPayload: {
        api_token: body.apiToken,
        api_url: body.apiUrl,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {
        apiUrl: body.apiUrl,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "ActiveCampaign connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("activecampaign", step.current, err, [
      body.apiToken,
    ]);
    console.error("[activecampaign/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
