import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Amazon Redshift"),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5439),
  database: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  ssl: z.boolean().default(true),
  schemas: z
    .string()
    .optional()
    .describe("Comma-separated schemas to sync (default: public)"),
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
    // Default the schema filter to `public` when blank. Without a filter
    // tap-postgres discovers pg_catalog + information_schema, which
    // collide with the BQ-reserved `information_schema` prefix in
    // target-bigquery.
    const schemas = body.schemas?.trim() ? body.schemas : "public";

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "redshift",
      name: body.name,
      ctx,
      secretPayload: {
        host: body.host,
        port: String(body.port),
        database: body.database,
        user: body.user,
        password: body.password,
        ssl: body.ssl ? "true" : "false",
        schemas,
      },
      firestoreFields: {
        host: body.host,
        port: body.port,
        database: body.database,
        user: body.user,
        ssl: body.ssl,
        schemas,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Connector saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("redshift", step.current, err, [
      body.password,
    ]);
    console.error(
      "[redshift/connect]",
      JSON.stringify(responseBody).slice(0, 2000)
    );
    return Response.json(responseBody, { status: 500 });
  }
}
