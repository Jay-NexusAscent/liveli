import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady } from "@/lib/firestore";
import { getExecutionStatus } from "@/lib/cloud-run";
import { dispatchMetadataEnrichment } from "@/lib/metadata/dispatcher";

export const runtime = "nodejs";
// 600s budget covers the post-response metadata-agent run scheduled
// via `after()` from the dispatcher. The HTTP response itself still
// returns in <5s; the extended budget is spent in the background
// while the agent enriches a freshly-synced connector. Bumped from
// 300s to handle customer schemas up to ~50 tables in one shot —
// at ~150 Gemini turns (per src/lib/metadata/agent.ts MAX_TURNS) × ~3s
// per turn ≈ 450s, with headroom. Above 50 tables, the dispatcher's
// gate-and-resume mechanism splits the work across subsequent /api/
// connectors polls; the budget here is sized for one-shot completion
// in the common case, not for unbounded schemas.
export const maxDuration = 600;

interface ConnectorDoc {
  status?: string;
  type?: string;
  lastExecutionName?: string;
  lastError?: string;
  lastSyncAttemptAt?: { _seconds?: number };
  lastSyncDurationMs?: number;
  typicalSyncDurationMs?: number;
  recentSyncDurationsMs?: number[];
  bqDataset?: string;
  bqLocation?: string;
  [k: string]: unknown;
}

/**
 * Rolling-average target sample size for "typical sync duration". Five
 * runs gives a sensible baseline that adapts to gradual data-volume
 * growth without overweighting a single anomalous run.
 */
const TYPICAL_SAMPLE_SIZE = 5;

/**
 * Given the connector's prior duration history + the just-completed run,
 * compute the patch fields for sync-time tracking. Caller merges into
 * the existing tryUpdate patch.
 */
function computeDurationPatch(
  data: ConnectorDoc,
  completionTime: unknown
): Record<string, unknown> {
  // Reconstruct start time from lastSyncAttemptAt (which the sync route
  // set when it kicked off the Cloud Run Job). Skip if missing.
  const startedAtSec = data.lastSyncAttemptAt?._seconds;
  if (typeof startedAtSec !== "number") return {};

  // completionTime comes from Cloud Run SDK as gax's ITimestamp shape:
  // { seconds?: number | string | Long; nanos?: number }. Accept anything
  // we can coerce to ms-epoch.
  let completedAtMs: number | null = null;
  if (completionTime instanceof Date) {
    completedAtMs = completionTime.getTime();
  } else if (typeof completionTime === "string") {
    const parsed = Date.parse(completionTime);
    if (!Number.isNaN(parsed)) completedAtMs = parsed;
  } else if (completionTime && typeof completionTime === "object") {
    const sec = (completionTime as { seconds?: unknown }).seconds;
    if (typeof sec === "number") completedAtMs = sec * 1000;
    else if (typeof sec === "string") completedAtMs = Number(sec) * 1000;
    else if (sec && typeof sec === "object") {
      // Long.js shape — toNumber()
      const n = (sec as { toNumber?: () => number }).toNumber?.();
      if (typeof n === "number") completedAtMs = n * 1000;
    }
  }
  if (completedAtMs === null) return {};

  const durationMs = completedAtMs - startedAtSec * 1000;
  if (durationMs <= 0 || durationMs > 1000 * 60 * 60 * 24) {
    // Sanity-check: negative duration (clock skew) or >24h (stale state).
    return {};
  }

  const recent = Array.isArray(data.recentSyncDurationsMs)
    ? data.recentSyncDurationsMs.filter(
        (v): v is number => typeof v === "number" && v > 0
      )
    : [];
  const updatedRecent = [...recent, durationMs].slice(-TYPICAL_SAMPLE_SIZE);
  const typical =
    updatedRecent.reduce((a, b) => a + b, 0) / updatedRecent.length;

  return {
    lastSyncDurationMs: durationMs,
    recentSyncDurationsMs: updatedRecent,
    typicalSyncDurationMs: Math.round(typical),
  };
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
      const reconciled = await reconcileStatus(col, d.id, data, {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
      });
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
  data: ConnectorDoc,
  ctx: { clientId: string; workspaceId: string }
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

  // Successful sync — capture duration for "typical sync duration" UI.
  const durationPatch = computeDurationPatch(data, exec.completionTime);
  const ok = await tryUpdate(col, connectorId, {
    status: "synced",
    lastError: FieldValue.delete(),
    lastSyncFinishedAt: FieldValue.serverTimestamp(),
    ...durationPatch,
  });
  if (!ok) return null;

  // Sync just transitioned to "synced" on this request. Hand off to the
  // metadata enrichment dispatcher — it runs the free INFORMATION_SCHEMA
  // pre-flight gate and, in dry-run mode, logs what would happen. The
  // dispatcher swallows its own errors so a metadata-pipeline glitch
  // never breaks the connector list. Awaited (not fire-and-forget)
  // because the gate is metadata-only and adds <1s; switch to
  // waitUntil() when live-mode Cloud Run dispatch lands.
  await dispatchMetadataEnrichment({
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    connectorId,
    connectorType: data.type ?? "",
    bqDataset: data.bqDataset,
    bqLocation: data.bqLocation,
  });

  return { ...data, status: "synced", lastError: undefined, ...durationPatch };
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
