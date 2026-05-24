import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("HubSpot"),
  accessToken: z
    .string()
    .min(1)
    .max(512)
    .regex(/^pat-/, "HubSpot Private App tokens start with pat-"),
  startDate: z.string().optional(),
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
    const startDate = body.startDate
      ? new Date(`${body.startDate}T00:00:00Z`).toISOString()
      : "";

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "hubspot",
      name: body.name,
      ctx,
      secretPayload: {
        access_token: body.accessToken,
        start_date: startDate,
      },
      firestoreFields: {
        startDate: startDate || undefined,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "HubSpot connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("hubspot", step.current, err, [
      body.accessToken,
    ]);
    console.error("[hubspot/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
