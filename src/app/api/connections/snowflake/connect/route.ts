import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { introspectSnowflakeSchema } from "@/lib/snowflake-introspection";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Snowflake auth = account locator + user/password + database +
 * warehouse (required — the tap needs compute to run queries). Schema
 * is optional; blank means discover all schemas in the database.
 *
 * We introspect at connect time (lib/snowflake-introspection.ts) to pick
 * a PER-STREAM write mode. Snowflake doesn't enforce primary keys, so a
 * single global mode is wrong: PK'd tables MERGE (upsert), no-PK tables
 * with a bookmark column append incrementally, and only the rest get
 * full-replace (overwrite). This keeps incremental syncs cheap without
 * wiping no-PK tables. Doubles as a creds liveness check.
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
    // Introspect the source BEFORE touching our own state — doubles as a
    // creds liveness check. Detects per-table replication strategy + the
    // per-stream loader write mode (upsert/append/overwrite). No
    // persistent resources exist yet, so nothing to clean up on failure.
    step.current = "introspect snowflake schema";
    let replicationConfig;
    try {
      replicationConfig = await introspectSnowflakeSchema({
        account: body.account,
        user: body.user,
        password: body.password,
        database: body.database,
        warehouse: body.warehouse,
        ...(body.schema?.trim() ? { schema: body.schema.trim() } : {}),
      });
    } catch (introspectErr) {
      const msg =
        introspectErr instanceof Error
          ? introspectErr.message
          : String(introspectErr);
      return Response.json(
        { error: "Couldn't connect to the Snowflake source", errorMessage: msg },
        { status: 400 }
      );
    }

    if (replicationConfig.detected.length === 0) {
      return Response.json(
        {
          error: `No tables found in database ${body.database}${
            body.schema?.trim() ? `, schema ${body.schema.trim()}` : ""
          }. Check the name and that your user/warehouse has SELECT privileges.`,
        },
        { status: 400 }
      );
    }

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
        // Per-stream replication strategy + loader write modes from
        // connect-time introspection, re-injected into meltano.yml at
        // sync time (see entrypoint.sh).
        replicationConfig,
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
