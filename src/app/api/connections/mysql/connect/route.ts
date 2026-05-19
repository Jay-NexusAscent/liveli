import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("MySQL"),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  database: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  ssl: z.boolean().default(false),
  filterDbs: z.string().optional().describe("Comma-separated dbs to replicate; defaults to the connection's own db"),
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
    // If the user left filter_dbs blank, default to the database they
    // connected against. This avoids tap-mysql pulling system schemas
    // (mysql / sys / performance_schema) which have reserved BQ prefix
    // collisions in target-bigquery, same gotcha as postgres.
    const filterDbs = body.filterDbs?.trim()
      ? body.filterDbs
      : body.database;

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "mysql",
      name: body.name,
      ctx,
      secretPayload: {
        host: body.host,
        port: String(body.port),
        database: body.database,
        user: body.user,
        password: body.password,
        ssl: body.ssl ? "true" : "false",
        filter_dbs: filterDbs,
      },
      firestoreFields: {
        host: body.host,
        port: body.port,
        database: body.database,
        user: body.user,
        ssl: body.ssl,
        filterDbs,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Connector saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("mysql", step.current, err);
    console.error("[mysql/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
