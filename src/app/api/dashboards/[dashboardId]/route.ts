import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, dashboardsIn } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * Delete a saved dashboard. Workspace-scoped — a request authenticated
 * to one workspace can't delete dashboards owned by another (the
 * `dashboardsIn` helper constrains the document path).
 *
 * The dashboard document holds its chart specs inline (no separate
 * collection), so a single doc-delete removes everything. Returns 404
 * if the dashboard doesn't exist or belongs to a different workspace.
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ dashboardId: string }> }
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

  const { dashboardId } = await context.params;

  await dbReady();
  const ref = dashboardsIn(ctx.clientId, ctx.workspaceId).doc(dashboardId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Dashboard not found" }, { status: 404 });
  }
  await ref.delete();
  return Response.json({ ok: true });
}
