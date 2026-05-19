import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady, workspaceDoc } from "@/lib/firestore";
import { readConnectorSecret } from "@/lib/secret-manager";
import { runConnectorJob } from "@/lib/cloud-run";
import { gcp } from "@/lib/gcp";
import { DEFAULT_BQ_LOCATION } from "@/lib/bigquery";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const { connectorId } = await context.params;

  await dbReady();
  const ref = connectorsIn(ctx.clientId, ctx.workspaceId).doc(connectorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  const data = snap.data() as {
    type: string;
    bqDataset: string;
    bqLocation?: "EU" | "US";
  };

  // Workspace BQ location for the target — prefer the connector's own
  // recorded location (set at create time), fall back to the workspace
  // setting, fall back to the global default.
  let location: string = data.bqLocation ?? DEFAULT_BQ_LOCATION;
  if (!data.bqLocation) {
    const wsSnap = await workspaceDoc(ctx.clientId, ctx.workspaceId).get();
    location = (wsSnap.data() as { bqLocation?: string })?.bqLocation ?? location;
  }

  const creds = await readConnectorSecret(ctx.clientId, connectorId);

  const jobName = `connector-${data.type}-to-bq`;

  // Per-invocation env overrides. Cloud Run encrypts in transit; values
  // exist only in the container's process env for the run's lifetime.
  const env: Record<string, string> = {
    WORKSPACE_ID: ctx.clientId, // legacy var name in the connector image
    CLIENT_ID: ctx.clientId,
    LIVELI_WORKSPACE_ID: ctx.workspaceId,
    CONNECTOR_ID: connectorId,
    TARGET_BIGQUERY_PROJECT: gcp.projectId,
    TARGET_BIGQUERY_DATASET: data.bqDataset,
    TARGET_BIGQUERY_LOCATION: location,
  };

  if (data.type === "postgres") {
    // filter_schemas restricts tap-postgres to user schemas only — without
    // it the tap discovers everything including pg_catalog and
    // information_schema, which then crashes target-bigquery because BQ
    // reserves the `information_schema` prefix on table names.
    const schemas = (creds.schemas ?? "public")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    Object.assign(env, {
      TAP_POSTGRES_HOST: creds.host,
      TAP_POSTGRES_PORT: creds.port,
      TAP_POSTGRES_USER: creds.user,
      TAP_POSTGRES_PASSWORD: creds.password,
      TAP_POSTGRES_DATABASE: creds.database,
      TAP_POSTGRES_FILTER_SCHEMAS: JSON.stringify(schemas),
    });
  } else {
    return Response.json(
      { error: `Sync not yet wired for connector type: ${data.type}` },
      { status: 400 }
    );
  }

  let executionName: string;
  try {
    const r = await runConnectorJob(jobName, env);
    executionName = r.executionName;
  } catch (err) {
    const technical = err instanceof Error ? err.message : String(err);
    console.error("[sync] runConnectorJob failed", {
      connectorId,
      clientId: ctx.clientId,
      msg: technical,
    });
    const lastError =
      "Couldn't start the sync. We're looking into it — contact support if this persists.";
    await ref.update({
      status: "error",
      lastError,
      lastErrorDiagnosticMessage: technical,
      lastSyncAttemptAt: FieldValue.serverTimestamp(),
    });
    return Response.json({ error: lastError }, { status: 500 });
  }

  await ref.update({
    status: "syncing",
    lastExecutionName: executionName,
    lastSyncAttemptAt: FieldValue.serverTimestamp(),
    lastError: FieldValue.delete(),
  });

  return Response.json({ ok: true, executionName });
}
