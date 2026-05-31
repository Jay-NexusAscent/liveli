import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Oracle auth = host/port + user/password + service name. The tap runs
 * in `thin` mode (pure-Python driver, no Instant Client — see
 * connectors/oracle-to-bq/meltano.yml). Schemas optional; blank means
 * discover all (minus SYS/SYSTEM). tap-oracle runs FULL_TABLE; loader
 * is overwrite.
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
