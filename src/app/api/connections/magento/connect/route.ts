import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Adobe Commerce / Magento 2 auth = store base URL + Integration access
 * token (Admin → System → Integrations). REST API.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Adobe Commerce"),
  storeUrl: z.string().url().max(255),
  accessToken: z.string().min(1).max(512),
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
    // Strip any trailing slash so the tap builds clean
    // <store>/rest/V1/... paths.
    const storeUrl = body.storeUrl.replace(/\/+$/, "");

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "magento",
      name: body.name,
      ctx,
      secretPayload: {
        store_url: storeUrl,
        access_token: body.accessToken,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {
        storeUrl,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Adobe Commerce connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("magento", step.current, err, [
      body.accessToken,
    ]);
    console.error("[magento/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
