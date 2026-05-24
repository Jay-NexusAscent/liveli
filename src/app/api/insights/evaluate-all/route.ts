import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady } from "@/lib/firestore";
import { evaluateAllInsights } from "@/lib/insights/evaluate";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Bulk re-evaluate every insight in the current workspace. Designed
 * to be the target of a Cloud Scheduler cron job — currently
 * workspace-scoped so it requires an authenticated request.
 *
 * Until the Cloud Scheduler binding lands (tracked in the Linear
 * follow-up ticket), this endpoint is reachable only via authenticated
 * UI calls — used by the "Re-evaluate all" affordance on /insights.
 * Without scheduled execution, alerts only update when manually
 * re-evaluated.
 *
 * Per-insight failures don't fail the whole batch — see
 * evaluateAllInsights for the per-id status breakdown. The response
 * shape gives the client enough to update each card or refetch the
 * full list.
 */
export async function POST() {
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
  const summary = await evaluateAllInsights({
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });
  return Response.json(summary);
}
