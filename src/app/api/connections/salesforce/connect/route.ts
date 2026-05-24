import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Salesforce"),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(512),
  refreshToken: z.string().min(1).max(2048),
  // "login" → login.salesforce.com (prod / developer orgs)
  // "test"  → test.salesforce.com  (sandboxes)
  domain: z.enum(["login", "test"]).default("login"),
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
      type: "salesforce",
      name: body.name,
      ctx,
      secretPayload: {
        client_id: body.clientId,
        client_secret: body.clientSecret,
        refresh_token: body.refreshToken,
        domain: body.domain,
      },
      firestoreFields: {
        domain: body.domain,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Salesforce connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("salesforce", step.current, err, [
      // clientId is the OAuth client identifier (not a secret); the
      // other two are sensitive.
      body.clientSecret,
      body.refreshToken,
    ]);
    console.error("[salesforce/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
