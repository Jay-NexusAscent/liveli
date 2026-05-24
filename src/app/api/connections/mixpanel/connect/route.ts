import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Mixpanel"),
  // Mixpanel Project API Secret (legacy) OR Service Account secret. Both
  // present as opaque ~32-char tokens — we don't try to discriminate.
  // The tap accepts either; project-level access is the same.
  apiSecret: z.string().min(16).max(512),
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
      type: "mixpanel",
      name: body.name,
      ctx,
      secretPayload: {
        api_secret: body.apiSecret,
      },
      // No non-secret per-connector state to surface — `firestoreFields`
      // is required on the input type, so pass {} explicitly. Same
      // pattern used by klaviyo/intercom/slack (Batch A).
      firestoreFields: {},
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Mixpanel connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("mixpanel", step.current, err, [
      body.apiSecret,
    ]);
    console.error("[mixpanel/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
