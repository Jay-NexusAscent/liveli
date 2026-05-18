import { auth } from "@clerk/nextjs/server";
import { FieldValue } from "@google-cloud/firestore";
import { dbReady, connectors } from "@/lib/firestore";
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
 * `status: "syncing"` against the live Cloud Run execution. This is a
 * per-request poll because we don't yet have a push channel from Cloud
 * Run back to Firestore — fine at demo scale, should move to Pub/Sub
 * once we have meaningful tenant counts.
 */
export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbReady();
  const snap = await connectors(orgId).get();

  const results = await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data() as ConnectorDoc;
      const reconciled = await reconcileStatus(orgId, d.id, data);
      // reconcileStatus returns null if the doc was deleted underneath
      // us (race between snap.get() and the reconcile write) — skip it.
      if (reconciled === null) return null;
      return { id: d.id, ...reconciled };
    })
  );

  // Filter out:
  //  - nulls from deleted-while-reconciling races
  //  - phantom docs missing `type` (left behind by an old version of
  //    this endpoint that used `.set(merge:true)` and could resurrect
  //    a doc that DELETE had just removed). Once you re-Delete those,
  //    they go away — until then we hide them from the UI.
  const items = results.filter(
    (item): item is NonNullable<typeof item> => item !== null && typeof item.type === "string"
  );

  return Response.json({ items });
}

/**
 * Returns the (possibly mutated) connector data, or `null` if the doc
 * has been deleted out from under us.
 */
async function reconcileStatus(
  orgId: string,
  connectorId: string,
  data: ConnectorDoc
): Promise<ConnectorDoc | null> {
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
    const ok = await tryUpdate(orgId, connectorId, {
      status: "synced",
      lastError: FieldValue.delete(),
    });
    if (!ok) return null;
    return { ...data, status: "synced", lastError: undefined };
  }

  // Still running — leave status as-is.
  if (!exec.completionTime) return data;

  if (exec.failedCount > 0) {
    const lastError = `Sync failed. Check Cloud Run logs: ${exec.logUri ?? "(no log URI)"}`;
    const ok = await tryUpdate(orgId, connectorId, {
      status: "error",
      lastError,
      lastSyncFinishedAt: FieldValue.serverTimestamp(),
    });
    if (!ok) return null;
    return { ...data, status: "error", lastError };
  }

  // Succeeded.
  const ok = await tryUpdate(orgId, connectorId, {
    status: "synced",
    lastError: FieldValue.delete(),
    lastSyncFinishedAt: FieldValue.serverTimestamp(),
  });
  if (!ok) return null;
  return { ...data, status: "synced", lastError: undefined };
}

/**
 * Firestore .update() throws NOT_FOUND (gRPC code 5) if the doc has
 * been deleted. We treat that as "fine, someone else cleaned up, don't
 * resurrect" and return false so the caller drops the row from the
 * list response.
 *
 * Using .update() instead of .set({merge:true}) is the actual fix for
 * the phantom-doc bug: set(merge:true) recreates a deleted doc with
 * only the patched fields, which is what produced the stuck-card
 * empty-fields connectors we saw in the UI.
 */
async function tryUpdate(
  orgId: string,
  connectorId: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  try {
    await connectors(orgId).doc(connectorId).update(patch);
    return true;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    // gRPC code 5 = NOT_FOUND. With fallback:rest it surfaces as HTTP 404.
    if (code === 5 || code === 404) return false;
    throw err;
  }
}
