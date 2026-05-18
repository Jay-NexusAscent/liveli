import { FieldValue } from "@google-cloud/firestore";
import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, connectorsIn, workspaceDoc } from "@/lib/firestore";
import { storeConnectorSecret } from "@/lib/secret-manager";
import {
  bqReady,
  connectorDatasetId,
  DEFAULT_BQ_LOCATION,
} from "@/lib/bigquery";
import { gcp } from "@/lib/gcp";
import { logUsageEvent } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Postgres"),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  ssl: z.boolean().default(true),
  schemas: z.string().optional().describe("Comma-separated schemas to sync (default: public)"),
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
    step.current = "dbReady";
    await dbReady();

    step.current = "create connector doc ref";
    const connectorRef = connectorsIn(ctx.clientId, ctx.workspaceId).doc();
    const connectorId = connectorRef.id;

    // Resolve the workspace's BQ location — set at workspace creation,
    // immutable afterwards. Defaults to EU if (somehow) missing.
    step.current = "load workspace location";
    const wsSnap = await workspaceDoc(ctx.clientId, ctx.workspaceId).get();
    const wsData = wsSnap.data() as { bqLocation?: "EU" | "US" } | undefined;
    const bqLocation = wsData?.bqLocation ?? DEFAULT_BQ_LOCATION;

    step.current = "bqReady";
    const bq = await bqReady();
    const datasetId = connectorDatasetId(ctx.clientId, ctx.workspaceId, connectorId);

    // Brand-new dataset per connector. Labels enable Cloud Billing Export
    // attribution downstream.
    step.current = `dataset.create (${datasetId}, location=${bqLocation})`;
    await bq.dataset(datasetId).create({
      location: bqLocation,
      labels: {
        customer: ctx.clientId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase(),
        workspace: ctx.workspaceId.toLowerCase(),
        connector: connectorId.toLowerCase(),
        type: "postgres",
      },
    });

    step.current = "storeConnectorSecret";
    const secretRef = await storeConnectorSecret(ctx.clientId, connectorId, {
      host: body.host,
      port: String(body.port),
      database: body.database,
      user: body.user,
      password: body.password,
      ssl: body.ssl ? "true" : "false",
      schemas: body.schemas ?? "public",
    });

    step.current = "firestore connector record";
    await connectorRef.set({
      type: "postgres",
      name: body.name,
      status: "configured",
      host: body.host,
      port: body.port,
      database: body.database,
      user: body.user,
      ssl: body.ssl,
      schemas: body.schemas ?? "public",
      syncFrequency: body.syncFrequency,
      secretRef,
      createdBy: ctx.userId,
      createdAt: FieldValue.serverTimestamp(),
      bqProject: gcp.projectId,
      bqDataset: datasetId,
      bqLocation,
    });

    logUsageEvent({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      eventType: "connector.create",
      resource: connectorId,
      labels: { type: "postgres", syncFrequency: body.syncFrequency },
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Connector saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const props: Record<string, unknown> = {};
    if (err && typeof err === "object") {
      for (const key of Object.getOwnPropertyNames(err)) {
        try {
          const v = (err as Record<string, unknown>)[key];
          props[key] = typeof v === "function" ? "[function]" : v;
        } catch {
          props[key] = "[unreadable]";
        }
      }
    }
    const responseBody = {
      error: `postgres/connect failed at step "${step.current}"`,
      errorType:
        (err as { constructor?: { name?: string } })?.constructor?.name ??
        typeof err,
      errorString: String(err),
      errorMessage:
        (err as { message?: string })?.message ?? String(err),
      errorProps: props,
    };
    console.error("[postgres/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
