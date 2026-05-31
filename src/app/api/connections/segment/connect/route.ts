import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Segment auth = a Public API token (workspace → Access Management →
 * Tokens). tap-segment reads the Config API (sources, destinations,
 * etc.), not raw event data.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Segment"),
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
      type: "segment",
      name: body.name,
      ctx,
      secretPayload: {
        api_token: body.apiToken,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {},
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Segment connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("segment", step.current, err, [
      body.apiToken,
    ]);
    console.error("[segment/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
