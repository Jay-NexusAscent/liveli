import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { introspectOracleSchema } from "@/lib/oracle-introspection";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Oracle auth = host/port + user/password + service name. The tap runs
 * in `thin` mode (pure-Python driver, no Instant Client — see
 * connectors/oracle-to-bq/meltano.yml). Schemas optional; blank means
 * the connecting user's own schema. We introspect at connect time
 * (lib/oracle-introspection.ts) to pick per-table INCREMENTAL/FULL_TABLE
 * + MERGE keys; the loader runs upsert.
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Oracle"),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(1521),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  serviceName: z.string().min(1).max(128),
  schemas: z
    .string()
    .max(512)
    .optional()
    .describe("Comma-separated schemas to replicate; blank = all"),
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
    // creds liveness check. Detects per-table replication strategy and
    // the no-PK tables that must be excluded under upsert MERGE. No
    // persistent resources exist yet, so nothing to clean up on failure.
    step.current = "introspect oracle schema";
    const schemaList = (body.schemas ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let replicationConfig;
    try {
      replicationConfig = await introspectOracleSchema({
        host: body.host,
        port: body.port,
        serviceName: body.serviceName,
        user: body.user,
        password: body.password,
        schemas: schemaList,
      });
    } catch (introspectErr) {
      const msg =
        introspectErr instanceof Error
          ? introspectErr.message
          : String(introspectErr);
      return Response.json(
        { error: "Couldn't connect to the Oracle source", errorMessage: msg },
        { status: 400 }
      );
    }

    if (replicationConfig.detected.length === 0) {
      return Response.json(
        {
          error: `No tables found in schema(s): ${
            schemaList.join(", ") || body.user.toUpperCase()
          }. Check the schema/owner name and that your user has SELECT privileges.`,
        },
        { status: 400 }
      );
    }

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "oracle",
      name: body.name,
      ctx,
      secretPayload: {
        host: body.host,
        port: String(body.port),
        user: body.user,
        password: body.password,
        service_name: body.serviceName,
        ...(body.schemas?.trim() ? { schemas: body.schemas.trim() } : {}),
      },
      firestoreFields: {
        host: body.host,
        port: body.port,
        user: body.user,
        serviceName: body.serviceName,
        ...(body.schemas?.trim() ? { schemas: body.schemas.trim() } : {}),
        // Per-stream replication strategy from connect-time introspection,
        // re-injected as a meltano.yml metadata block at sync time.
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
    const responseBody = connectErrorEnvelope("oracle", step.current, err, [
      body.password,
    ]);
    console.error("[oracle/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
