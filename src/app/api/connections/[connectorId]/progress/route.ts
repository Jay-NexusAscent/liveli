import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady } from "@/lib/firestore";
import { getExecutionProgress } from "@/lib/cloud-run";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * Live in-flight sync progress for the UI's polling indicator.
 *
 * Returns one of two response shapes:
 *
 *   { state: "idle" }
 *     — connector isn't currently syncing.
 *
 *   { state: "syncing", phase, recordsProcessed, elapsedMs, typicalMs,
 *     percent?, latestLogLine? }
 *     — sync in progress. UI shows phase + elapsed + (if typicalMs is
 *       known from prior runs) a percentage of typical.
 *
 * Best-effort. If Cloud Logging is slow / errors out, the response still
 * includes elapsed time from Firestore — just no row count.
 */
export async function GET(
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
  const snap = await connectorsIn(ctx.clientId, ctx.workspaceId)
    .doc(connectorId)
    .get();
  if (!snap.exists) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  const data = snap.data() as {
    status?: string;
    lastExecutionName?: string;
    lastSyncAttemptAt?: { _seconds?: number };
    typicalSyncDurationMs?: number;
  };

  if (data.status !== "syncing" || !data.lastExecutionName) {
    return Response.json({ state: "idle" });
  }

  const startedAtSec = data.lastSyncAttemptAt?._seconds ?? null;
  const elapsedMs =
    startedAtSec !== null ? Date.now() - startedAtSec * 1000 : 0;

  const progress = await getExecutionProgress(data.lastExecutionName);

  const typicalMs = data.typicalSyncDurationMs ?? null;
  // Naive percent of typical — capped at 99 because we don't know if
  // *this* run will actually be average. Never show 100% pre-completion.
  const percent =
    typicalMs && elapsedMs > 0
      ? Math.min(99, Math.round((elapsedMs / typicalMs) * 100))
      : null;

  return Response.json({
    state: "syncing",
    phase: progress?.phase ?? "unknown",
    recordsProcessed: progress?.recordsProcessed ?? 0,
    elapsedMs,
    typicalMs,
    percent,
    latestLogLine: progress?.latestLogLine ?? null,
  });
}
