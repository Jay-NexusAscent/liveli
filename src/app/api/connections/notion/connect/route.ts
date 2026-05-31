import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Notion auth = an internal-integration token (created at
 * notion.so/my-integrations), which starts `secret_` or `ntn_`. NOT OAuth.
 * GOTCHA surfaced in the wizard: the customer must SHARE each page/database
 * with the integration, or the tap sees nothing.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Notion"),
  authToken: z
    .string()
    .min(1)
    .max(512)
    .regex(/^(secret_|ntn_)/, "Notion integration tokens start with secret_ or ntn_"),
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
      type: "notion",
      name: body.name,
      ctx,
      secretPayload: {
        auth_token: body.authToken,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {},
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Notion connection saved. Share your pages with the integration, then click Sync.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("notion", step.current, err, [
      body.authToken,
    ]);
    console.error("[notion/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
