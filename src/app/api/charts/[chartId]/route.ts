import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, chartsIn } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * Delete a saved chart. Workspace-scoped — a request authenticated to
 * one workspace can't delete charts owned by another (the `chartsIn`
 * helper already enforces this by constraining the document path).
 *
 * Returns 404 if the chart doesn't exist or belongs to a different
 * workspace; both cases are treated the same so we don't leak whether
 * an arbitrary chartId exists anywhere in the system.
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ chartId: string }> }
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

  const { chartId } = await context.params;

  await dbReady();
  const ref = chartsIn(ctx.clientId, ctx.workspaceId).doc(chartId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Chart not found" }, { status: 404 });
  }
  await ref.delete();
  return Response.json({ ok: true });
}
