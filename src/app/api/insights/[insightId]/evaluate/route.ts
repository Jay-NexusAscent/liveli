import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady } from "@/lib/firestore";
import { evaluateInsight } from "@/lib/insights/evaluate";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Manually re-evaluate a single insight. Re-runs its sourceSql,
 * applies the rule, updates Firestore, returns the resulting state.
 *
 * Used by the "Re-evaluate" button on each insight card. The bulk
 * cron-targeted path lives at /api/insights/evaluate-all.
 *
 * Per-eval errors do NOT 500 — they return `{ ok: false, error }`
 * with status 200 so the UI can surface them inline. The card's
 * lastEvalError field is also written; the displayed value/state
 * remain whatever the last successful eval set them to (same
 * staleness model as filter-driven charts).
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ insightId: string }> }
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

  const { insightId } = await context.params;

  await dbReady();
  const result = await evaluateInsight(insightId, {
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });

  if (!result.ok && !result.insight) {
    // No insight exists OR no doc to update — report 404.
    // (evaluateInsight returns ok:false with "Insight not found" in
    // that case; eval errors leave the doc in place but ok:false.)
    if (result.error === "Insight not found") {
      return Response.json({ error: result.error }, { status: 404 });
    }
  }

  return Response.json({
    ok: result.ok,
    error: result.error,
    insight: result.insight,
  });
}
