import { auth } from "@clerk/nextjs/server";
import { FieldValue } from "@google-cloud/firestore";
import { dbReady, connectors } from "@/lib/firestore";
import { readConnectorSecret } from "@/lib/secret-manager";
import { runConnectorJob } from "@/lib/cloud-run";
import { gcp } from "@/lib/gcp";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { connectorId } = await context.params;

  await dbReady();
  const ref = connectors(orgId).doc(connectorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  const data = snap.data() as {
    type: string;
    bqDataset: string;
  };

  // Look up the source-system credentials we stored at connect time.
  const creds = await readConnectorSecret(orgId, connectorId);

  // Map connector type → Cloud Run Job name + env shape
  const jobName = `connector-${data.type}-to-bq`;

  // Per-invocation env overrides — passed via Cloud Run Job override mechanism.
  // Source creds are passed through; cloud-run.googleapis.com encrypts in
  // transit and the values exist only in the running container's process env.
  // Tighter pattern (secretKeyRef in static job spec) tracked in LIVELI backlog.
  const env: Record<string, string> = {
    WORKSPACE_ID: orgId,
    CONNECTOR_ID: connectorId,
    TARGET_BIGQUERY_PROJECT: gcp.projectId,
    TARGET_BIGQUERY_DATASET: data.bqDataset,
    TARGET_BIGQUERY_LOCATION: "US",
  };

  if (data.type === "postgres") {
    Object.assign(env, {
      TAP_POSTGRES_HOST: creds.host,
      TAP_POSTGRES_PORT: creds.port,
      TAP_POSTGRES_USER: creds.user,
      TAP_POSTGRES_PASSWORD: creds.password,
      TAP_POSTGRES_DATABASE: creds.database,
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
    const message = err instanceof Error ? err.message : String(err);
    await ref.update({
      status: "error",
      lastError: message,
      lastSyncAttemptAt: FieldValue.serverTimestamp(),
    });
    return Response.json({ error: message }, { status: 500 });
  }

  await ref.update({
    status: "syncing",
    lastExecutionName: executionName,
    lastSyncAttemptAt: FieldValue.serverTimestamp(),
    lastError: FieldValue.delete(),
  });

  return Response.json({ ok: true, executionName });
}
