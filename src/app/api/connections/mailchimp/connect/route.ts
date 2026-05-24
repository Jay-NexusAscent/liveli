import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Mailchimp"),
  apiKey: z
    .string()
    .min(1)
    .max(512)
    // -usNN suffix is the data center selector; tap-mailchimp parses it
    // out of the API key itself, so we keep it intact in the secret.
    .regex(/-us\d+$/i, "Mailchimp API keys end with -usNN (e.g. -us21)"),
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
    // Extract the data-center suffix for the edit modal — it's not a
    // secret, just the routing hint, and showing it ("Mailchimp · us21")
    // helps customers identify which key they used.
    const dcMatch = body.apiKey.match(/-us(\d+)$/i);
    const dataCenter = dcMatch ? `us${dcMatch[1]}` : undefined;

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "mailchimp",
      name: body.name,
      ctx,
      secretPayload: {
        api_key: body.apiKey,
      },
      firestoreFields: {
        dataCenter,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Mailchimp connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("mailchimp", step.current, err, [
      body.apiKey,
    ]);
    console.error("[mailchimp/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
