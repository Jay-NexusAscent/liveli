import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, insightsIn } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * Delete a saved insight. Workspace-scoped via the `insightsIn` path
 * — a request authenticated to workspace A can't delete insights
 * owned by workspace B. Returns 404 for missing OR mis-scoped ids.
 *
 * No soft-delete in v1 — when LIVELI-75 adds the 30-day grace period
 * for accounts, insights will inherit that policy automatically since
 * they live under the workspace doc.
 */
export async function DELETE(
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
  const ref = insightsIn(ctx.clientId, ctx.workspaceId).doc(insightId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Insight not found" }, { status: 404 });
  }
  await ref.delete();
  return Response.json({ ok: true });
}
