import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Meta Ads"),
  accessToken: z.string().min(1).max(2048),
  accountId: z
    .string()
    .regex(/^act_\d+$/, "accountId must look like act_<digits>"),
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
      type: "facebook-ads",
      name: body.name,
      ctx,
      secretPayload: {
        access_token: body.accessToken,
        account_id: body.accountId,
      },
      firestoreFields: {
        accountId: body.accountId,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Meta Ads connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("facebook-ads", step.current, err);
    console.error("[facebook-ads/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
