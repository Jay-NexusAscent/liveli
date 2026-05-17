import { auth } from "@clerk/nextjs/server";
import { FieldValue } from "@google-cloud/firestore";
import { dbReady, connectors } from "@/lib/firestore";
import { getExecutionStatus } from "@/lib/cloud-run";

export const runtime = "nodejs";
export const maxDuration = 30;

interface ConnectorDoc {
  status?: string;
  lastExecutionName?: string;
  lastError?: string;
  [k: string]: unknown;
}

/**
 * List the workspace's connectors. Before returning, reconcile any
 * connector still showing `status: "syncing"` against the live Cloud
 * Run execution — if the job has finished (success or failure) we
 * patch Firestore so the UI stops claiming an in-flight sync forever.
 *
 * This is a per-request poll because we don't yet have a push channel
 * from Cloud Run back to Firestore. It's cheap at demo scale (1–3
 * connectors per workspace) but should move to Pub/Sub or a Scheduler
 * sweep once we have meaningful tenant counts.
 */
export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbReady();
  const snap = await connectors(orgId).get();

  const items = await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data() as ConnectorDoc;
      const reconciled = await reconcileStatus(orgId, d.id, data);
      return { id: d.id, ...reconciled };
    })
  );

  return Response.json({ items });
}

async function reconcileStatus(
  orgId: string,
  connectorId: string,
  data: ConnectorDoc
): Promise<ConnectorDoc> {
  // Only reconcile if Firestore thinks we're mid-sync and we have
  // an execution name to look up.
  if (data.status !== "syncing" || !data.lastExecutionName) {
    return data;
  }

  let exec;
  try {
    exec = await getExecutionStatus(data.lastExecutionName);
  } catch {
    // Execution gone (Cloud Run GCs old executions after ~7d). Don't
    // leave the card spinning forever — assume it finished.
    const patch = { status: "synced", lastError: FieldValue.delete() };
    await connectors(orgId).doc(connectorId).set(patch, { merge: true });
    return { ...data, status: "synced", lastError: undefined };
  }

  // Still running — leave status as-is.
  if (!exec.completionTime) return data;

  if (exec.failedCount > 0) {
    const lastError = `Sync failed. Check Cloud Run logs: ${exec.logUri ?? "(no log URI)"}`;
    await connectors(orgId).doc(connectorId).set(
      { status: "error", lastError, lastSyncFinishedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { ...data, status: "error", lastError };
  }

  // Succeeded.
  await connectors(orgId).doc(connectorId).set(
    {
      status: "synced",
      lastError: FieldValue.delete(),
      lastSyncFinishedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ...data, status: "synced", lastError: undefined };
}
