import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * TikTok Ads auth = long-lived access token + advertiser ID (numeric,
 * from the TikTok Ads Manager account). TikTok Marketing API.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("TikTok Ads"),
  accessToken: z.string().min(1).max(512),
  advertiserId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^\d+$/, "Advertiser ID must be the numeric ID from TikTok Ads Manager"),
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
      type: "tiktok-ads",
      name: body.name,
      ctx,
      secretPayload: {
        access_token: body.accessToken,
        advertiser_id: body.advertiserId,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {
        advertiserId: body.advertiserId,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "TikTok Ads connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("tiktok-ads", step.current, err, [
      body.accessToken,
    ]);
    console.error("[tiktok-ads/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
