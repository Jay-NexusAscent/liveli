import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Sage Intacct (XML Gateway API) auth has two credential layers:
 *   - sender_id + sender_password: the web-services SENDER credentials,
 *     issued by Sage to the integration (app-level).
 *   - user_id + user_password: the customer's web-services USER login,
 *     scoped to their company (company_id).
 * All four plus company_id are required.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Sage Intacct"),
  companyId: z.string().min(1).max(128),
  senderId: z.string().min(1).max(128),
  senderPassword: z.string().min(1).max(512),
  userId: z.string().min(1).max(128),
  userPassword: z.string().min(1).max(512),
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
      type: "sage-intacct",
      name: body.name,
      ctx,
      secretPayload: {
        company_id: body.companyId,
        sender_id: body.senderId,
        sender_password: body.senderPassword,
        user_id: body.userId,
        user_password: body.userPassword,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {
        companyId: body.companyId,
        userId: body.userId,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Sage Intacct connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("sage-intacct", step.current, err, [
      body.senderPassword,
      body.userPassword,
    ]);
    console.error("[sage-intacct/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
