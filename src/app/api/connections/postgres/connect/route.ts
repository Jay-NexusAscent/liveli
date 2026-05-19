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
import { upsertSyncJob, deleteSyncJob } from "@/lib/cloud-scheduler";
import { deleteConnectorSecret } from "@/lib/secret-manager";

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

  // Track what we've created so we can undo on partial failure.
  // Without this, a failure between BQ-dataset-create and Firestore-doc-
  // write leaves an orphan dataset (and a secret with no record pointing
  // at it). The compensating delete in the catch block reverses whatever
  // got created up to the failure point.
  const created = {
    bqDataset: null as string | null,
    secret: null as { connectorId: string } | null,
    firestoreDoc: null as FirebaseFirestore.DocumentReference | null,
    schedulerJob: null as { connectorId: string } | null,
  };

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
    created.bqDataset = datasetId;

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
    created.secret = { connectorId };

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
    created.firestoreDoc = connectorRef;

    // Wire the recurring Scheduler job for this connector. Failures
    // here are logged but never block the connector save — manual
    // "Sync now" still works without the scheduled trigger.
    step.current = "upsertSyncJob (Cloud Scheduler)";
    await upsertSyncJob({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      connectorId,
      syncFrequency: body.syncFrequency,
    });
    created.schedulerJob = { connectorId };

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
    // ── Compensating cleanup (reverse order of creation) ──────────
    // Best-effort. Any failure here is logged but doesn't prevent
    // the original error from surfacing. The goal is to leave the
    // system in the same state as before this request ran.
    const cleanupErrors: string[] = [];

    if (created.schedulerJob) {
      try {
        await deleteSyncJob(ctx.clientId, created.schedulerJob.connectorId);
      } catch (cleanupErr) {
        cleanupErrors.push(
          `scheduler: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
      }
    }

    if (created.firestoreDoc) {
      try {
        await created.firestoreDoc.delete();
      } catch (cleanupErr) {
        cleanupErrors.push(
          `firestore: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
      }
    }

    if (created.secret) {
      try {
        await deleteConnectorSecret(ctx.clientId, created.secret.connectorId);
      } catch (cleanupErr) {
        cleanupErrors.push(
          `secret: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
      }
    }

    if (created.bqDataset) {
      try {
        const bq = await bqReady();
        await bq.dataset(created.bqDataset).delete({ force: true });
      } catch (cleanupErr) {
        const code = (cleanupErr as { code?: number })?.code;
        if (code !== 404) {
          cleanupErrors.push(
            `bq: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
          );
        }
      }
    }

    if (cleanupErrors.length > 0) {
      console.error("[postgres/connect] compensating cleanup had failures", {
        clientId: ctx.clientId,
        cleanupErrors,
      });
    }

    // Some SDK errors attach the request payload to .config / .request /
    // ._request — which for storeConnectorSecret means the user's
    // password could end up serialised into our error envelope. Filter
    // hard on both keys (anything credential-shaped) AND values (the
    // password string they just submitted).
    const SENSITIVE_KEYS = /password|secret|token|credential|api[_-]?key|authorization/i;
    const userInputSensitiveValues = [body.password].filter(Boolean);

    const sanitise = (val: unknown): unknown => {
      if (typeof val === "string") {
        let s = val;
        for (const sv of userInputSensitiveValues) {
          if (sv && s.includes(sv)) s = s.split(sv).join("[redacted]");
        }
        return s;
      }
      return val;
    };

    const props: Record<string, unknown> = {};
    if (err && typeof err === "object") {
      for (const key of Object.getOwnPropertyNames(err)) {
        if (SENSITIVE_KEYS.test(key)) {
          props[key] = "[redacted]";
          continue;
        }
        try {
          const v = (err as Record<string, unknown>)[key];
          if (typeof v === "function") {
            props[key] = "[function]";
          } else if (typeof v === "object" && v !== null) {
            // Shallow scan — most SDK errors aren't deeper than 2-3 levels
            // and we don't want to walk circular refs. JSON.stringify with
            // a replacer that redacts at any depth.
            props[key] = JSON.parse(
              JSON.stringify(v, (k, x) => {
                if (typeof k === "string" && SENSITIVE_KEYS.test(k)) return "[redacted]";
                return sanitise(x);
              })
            );
          } else {
            props[key] = sanitise(v);
          }
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
      errorString: sanitise(String(err)),
      errorMessage: sanitise(
        (err as { message?: string })?.message ?? String(err)
      ),
      errorProps: props,
    };
    console.error("[postgres/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
