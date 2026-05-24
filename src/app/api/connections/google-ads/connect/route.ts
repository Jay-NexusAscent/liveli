import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Google Ads"),
  developerToken: z.string().min(1).max(512),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(512),
  refreshToken: z.string().min(1).max(2048),
  // Wizard validates + normalises customer IDs (10-digit, no dashes) and
  // sends them comma-separated. Be defensive and re-validate on the server.
  customerIds: z
    .string()
    .min(10)
    .regex(/^\d{10}(,\d{10})*$/, "customerIds must be comma-separated 10-digit IDs"),
  loginCustomerId: z
    .string()
    .optional()
    .refine(
      (v) => !v || /^\d{10}$/.test(v),
      "loginCustomerId must be a 10-digit number or empty"
    ),
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
      type: "google-ads",
      name: body.name,
      ctx,
      secretPayload: {
        developer_token: body.developerToken,
        client_id: body.clientId,
        client_secret: body.clientSecret,
        refresh_token: body.refreshToken,
        customer_ids: body.customerIds,
        login_customer_id: body.loginCustomerId ?? "",
      },
      // Display fields only — credentials never leave Secret Manager.
      firestoreFields: {
        customerIds: body.customerIds,
        loginCustomerId: body.loginCustomerId,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Google Ads connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("google-ads", step.current, err, [
      // clientId is a public OAuth client identifier, NOT a secret —
      // omit. Developer token / client secret / refresh token are all
      // sensitive.
      body.developerToken,
      body.clientSecret,
      body.refreshToken,
    ]);
    console.error("[google-ads/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
