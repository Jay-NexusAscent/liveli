import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, dashboardsIn } from "@/lib/firestore";

export const runtime = "nodejs";

const PatchBody = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(280).nullable().optional(),
  charts: z
    .array(
      z.object({
        order: z.number().optional(),
        title: z.string(),
        spec: z.unknown(),
      })
    )
    .min(1)
    .max(8)
    .optional(),
});

/**
 * Update a saved dashboard's title, description, and/or charts list.
 * Each field is optional; the bits that aren't provided stay as-is.
 * When `charts` IS provided it REPLACES the existing array entirely.
 * Workspace-scoped.
 *
 * Used by the agent's `update_dashboard` tool when an Edit-via-chat
 * session applies model-generated changes to a dashboard.
 */
export async function PATCH(
  req: Request,
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
  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }
  if (
    body.title === undefined &&
    body.description === undefined &&
    body.charts === undefined
  ) {
    return Response.json(
      { error: "Provide title, description, and/or charts." },
      { status: 400 }
    );
  }

  await dbReady();
  const ref = dashboardsIn(ctx.clientId, ctx.workspaceId).doc(dashboardId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Dashboard not found" }, { status: 404 });
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (body.title !== undefined) update.title = body.title;
  if (body.description !== undefined) update.description = body.description ?? null;
  if (body.charts !== undefined) {
    update.charts = body.charts.map((c, i) => ({
      order: c.order ?? i,
      title: c.title,
      spec: c.spec,
    }));
  }
  await ref.update(update);
  return Response.json({ ok: true });
}

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
