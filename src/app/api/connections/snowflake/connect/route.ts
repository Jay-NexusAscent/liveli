import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Snowflake auth = account locator + user/password + database +
 * warehouse (required — the tap needs compute to run queries). Schema
 * is optional; blank means discover all schemas in the database.
 * tap-snowflake runs FULL_TABLE; the BQ loader is overwrite.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Snowflake"),
  account: z.string().min(1).max(255),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  database: z.string().min(1).max(128),
  warehouse: z.string().min(1).max(128),
  schema: z.string().max(128).optional(),
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
      type: "snowflake",
      name: body.name,
      ctx,
      secretPayload: {
        account: body.account,
        user: body.user,
        password: body.password,
        database: body.database,
        warehouse: body.warehouse,
        ...(body.schema?.trim() ? { schema: body.schema.trim() } : {}),
      },
      firestoreFields: {
        account: body.account,
        user: body.user,
        database: body.database,
        warehouse: body.warehouse,
        ...(body.schema?.trim() ? { schema: body.schema.trim() } : {}),
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Connector saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("snowflake", step.current, err, [
      body.password,
    ]);
    console.error("[snowflake/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
