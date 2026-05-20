import { FieldValue } from "@google-cloud/firestore";
import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady } from "@/lib/firestore";
import { pauseSyncJob, resumeSyncJob } from "@/lib/cloud-scheduler";
import { logUsageEvent } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Pause or resume the Cloud Scheduler job for one connector.
 *
 * Paused: scheduled syncs stop firing. Manual "Sync now" still works
 * (the route here only touches Scheduler, not the underlying ELT).
 * The connector's existing status ("synced"/"error"/etc.) is preserved
 * — we add an orthogonal `paused: boolean` field on the connector doc
 * so the UI can show "Paused" alongside the last-sync status.
 *
 * Body: { paused: boolean }
 *   - paused=true  → Cloud Scheduler pauseJob + Firestore paused=true
 *   - paused=false → Cloud Scheduler resumeJob + Firestore paused=false
 *
 * In-flight executions are NOT cancelled by pause — only future cron
 * fires are suppressed. If the customer needs to abort a running sync
 * that's a separate concern (Cloud Run Job cancellation, not done here).
 */
const Body = z.object({
  paused: z.boolean(),
});

export async function POST(
  req: Request,
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

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  await dbReady();
  const ref = connectorsIn(ctx.clientId, ctx.workspaceId).doc(connectorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  const data = snap.data() as { type?: string };

  try {
    if (body.paused) {
      await pauseSyncJob(ctx.clientId, connectorId);
    } else {
      await resumeSyncJob(ctx.clientId, connectorId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pause] scheduler call failed", {
      connectorId,
      paused: body.paused,
      msg: message,
    });
    return Response.json(
      {
        error: body.paused
          ? "Couldn't pause the schedule. Try again, or contact support if this persists."
          : "Couldn't resume the schedule. Try again, or contact support if this persists.",
        errorMessage: message,
      },
      { status: 500 }
    );
  }

  await ref.update({
    paused: body.paused,
    pausedAt: body.paused ? FieldValue.serverTimestamp() : FieldValue.delete(),
  });

  logUsageEvent({
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    eventType: body.paused ? "connector.pause" : "connector.resume",
    resource: connectorId,
    labels: { type: data.type ?? "unknown" },
  });

  return Response.json({ ok: true, paused: body.paused });
}
