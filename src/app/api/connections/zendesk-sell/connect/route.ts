import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Zendesk Sell (CRM, formerly Base) auth = OAuth access token. The Sync
 * API needs a stable `device_uuid` to track incremental sync state per
 * client — we generate one at connect time and persist it in the secret
 * so every sync reuses the same device session.
 *
 * NOTE: distinct product from Zendesk Support (the `zendesk` connector).
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Zendesk Sell"),
  accessToken: z.string().min(1).max(512),
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
    const deviceUuid = randomUUID();

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "zendesk-sell",
      name: body.name,
      ctx,
      secretPayload: {
        access_token: body.accessToken,
        device_uuid: deviceUuid,
      },
      firestoreFields: {},
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Zendesk Sell connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("zendesk-sell", step.current, err, [
      body.accessToken,
    ]);
    console.error("[zendesk-sell/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
