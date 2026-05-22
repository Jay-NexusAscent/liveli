import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Stripe"),
  apiKey: z
    .string()
    .min(1)
    .max(512)
    .regex(/^sk_(live|test)_/, "Stripe secret keys start with sk_live_ or sk_test_"),
  // Wizard date input emits YYYY-MM-DD; entrypoint accepts any ISO8601
  // and falls back to 1y-ago when blank.
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
    // Convert YYYY-MM-DD → full ISO instant so the tap doesn't have to
    // do timezone gymnastics.
    const startDate = body.startDate
      ? new Date(`${body.startDate}T00:00:00Z`).toISOString()
      : "";

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "stripe",
      name: body.name,
      ctx,
      secretPayload: {
        api_key: body.apiKey,
        start_date: startDate,
      },
      // Mode is useful for the edit modal so the user can see which key
      // is in play without us ever exposing the key itself.
      firestoreFields: {
        keyMode: body.apiKey.startsWith("sk_live_") ? "live" : "test",
        startDate: startDate || undefined,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Stripe connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("stripe", step.current, err, [
      body.apiKey,
    ]);
    console.error("[stripe/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
