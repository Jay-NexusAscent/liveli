import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady } from "@/lib/firestore";
import { getExecutionStatus } from "@/lib/cloud-run";

export const runtime = "nodejs";
export const maxDuration = 30;

interface ConnectorDoc {
  status?: string;
  type?: string;
  lastExecutionName?: string;
  lastError?: string;
  [k: string]: unknown;
}

/**
 * List the workspace's connectors. Reconciles any connector still showing
 * `status: "syncing"` against the live Cloud Run execution. Per-request
 * poll because we don't yet have a push channel from Cloud Run back to
 * Firestore — fine at demo scale, move to Pub/Sub at tenant scale.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  await dbReady();
  const col = connectorsIn(ctx.clientId, ctx.workspaceId);
  const snap = await col.get();

  const results = await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data() as ConnectorDoc;
      const reconciled = await reconcileStatus(col, d.id, data);
      if (reconciled === null) return null;
      return { id: d.id, ...reconciled };
    })
  );

  // Filter phantom docs missing `type` (left behind by old set(merge:true)
  // bug) so they don't appear in the UI even if they exist.
  const items = results.filter(
    (item): item is NonNullable<typeof item> =>
      item !== null && typeof item.type === "string"
  );

  return Response.json({ items });
}

async function reconcileStatus(
  col: FirebaseFirestore.CollectionReference,
  connectorId: string,
  data: ConnectorDoc
): Promise<ConnectorDoc | null> {
  if (data.status !== "syncing" || !data.lastExecutionName) {
    return data;
  }

  let exec;
  try {
    exec = await getExecutionStatus(data.lastExecutionName);
  } catch (err) {
    // ONLY treat actual NOT_FOUND as "execution garbage-collected,
    // assume it finished". Anything else (bad arg, perm denied, etc.)
    // must NOT silently mark the connector synced — that's how the
    // earlier LRO-name-vs-execution-name bug masked a failed sync as
    // a green "Synced" badge.
    const code = (err as { code?: number; status?: string })?.code;
    const status = (err as { code?: number; status?: string })?.status;
    const isNotFound = code === 5 || code === 404 || status === "NOT_FOUND";
    if (isNotFound) {
      const ok = await tryUpdate(col, connectorId, {
        status: "synced",
        lastError: FieldValue.delete(),
      });
      if (!ok) return null;
      return { ...data, status: "synced", lastError: undefined };
    }
    // Any other error: surface a friendly message in the UI, log the
    // technical detail server-side for ops triage.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync] reconcile lookup failed", { connectorId, msg });
    const lastError =
      "We're having trouble checking sync status. We'll retry automatically — contact support if this persists.";
    const ok = await tryUpdate(col, connectorId, {
      status: "error",
      lastError,
      lastErrorDiagnosticMessage: msg,
    });
    if (!ok) return null;
    return { ...data, status: "error", lastError };
  }

  if (!exec.completionTime) return data;

  if (exec.failedCount > 0) {
    // Customer-facing copy — never leak Cloud Run / BigQuery / Meltano
    // internals. The full diagnostic (log URL + execution name) goes to
    // the server console for ops triage and into a separate diagnostic
    // field on the doc so it's accessible from admin tooling later
    // without surfacing in the UI.
    const lastError =
      "Sync failed. Check that your connection details are still valid, or contact support if this keeps happening.";
    const diagnosticLogUri = exec.logUri ?? null;
    console.error("[sync] execution failed", {
      connectorId,
      executionName: data.lastExecutionName,
      logUri: diagnosticLogUri,
    });
    const ok = await tryUpdate(col, connectorId, {
      status: "error",
      lastError,
      lastErrorDiagnosticLogUri: diagnosticLogUri,
      lastSyncFinishedAt: FieldValue.serverTimestamp(),
    });
    if (!ok) return null;
    return { ...data, status: "error", lastError };
  }

  const ok = await tryUpdate(col, connectorId, {
    status: "synced",
    lastError: FieldValue.delete(),
    lastSyncFinishedAt: FieldValue.serverTimestamp(),
  });
  if (!ok) return null;
  return { ...data, status: "synced", lastError: undefined };
}

async function tryUpdate(
  col: FirebaseFirestore.CollectionReference,
  connectorId: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  try {
    await col.doc(connectorId).update(patch);
    return true;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 5 || code === 404) return false;
    throw err;
  }
}
