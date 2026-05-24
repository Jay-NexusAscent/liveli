import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Amplitude"),
  // Amplitude API Key (public, project identifier) — paired with the
  // Secret Key for HTTP Basic auth against the Export API.
  apiKey: z.string().min(16).max(512),
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
      type: "amplitude",
      name: body.name,
      ctx,
      secretPayload: {
        // Both go in the secret bundle — even though apiKey is "public"
        // it's still credential-adjacent (paired with the secret it
        // becomes a working credential), so keep them together and out
        // of Firestore.
        api_key: body.apiKey,
        api_secret: body.apiSecret,
      },
      // No non-secret per-connector state to surface — `firestoreFields`
      // is required on the input type, so pass {} explicitly.
      firestoreFields: {},
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Amplitude connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("amplitude", step.current, err, [
      body.apiKey,
      body.apiSecret,
    ]);
    console.error("[amplitude/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
