import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, dashboardsIn } from "@/lib/firestore";
import { COL_SPAN_VALUES } from "@/lib/dashboards/types";

export const runtime = "nodejs";

const PatchBody = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(280).nullable().optional(),
  // Favourite flag, toggled from the dashboard gallery. Persisted on
  // the doc (not per-user) — workspace-scoped dashboards in single-user
  // private testing, so a doc-level flag is the right granularity.
  favorite: z.boolean().optional(),
  charts: z
    .array(
      z.object({
        order: z.number().optional(),
        title: z.string(),
        spec: z.unknown(),
        // Optional per-tile size hint. See make-dashboard.ts for the
        // full extra-small / small / medium / large → width × row-span
        // mapping. extra-small is the half-height ¼-width tile used
        // for KPI cards.
        colSpan: z.enum(COL_SPAN_VALUES).optional(),
        // Filter-driven re-render fields (LIVELI-122 Phase 2). The
        // client passes these through on reorder/resize so we don't
        // silently downgrade a filter-driven chart to static. Both are
        // opaque to this endpoint — schema validation happens at
        // chart-create / update time in make_dashboard /
        // update_dashboard. We just round-trip the bytes.
        sourceSql: z.string().min(1).optional(),
        dataMapping: z.unknown().optional(),
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
    body.favorite === undefined &&
    body.charts === undefined
  ) {
    return Response.json(
      { error: "Provide title, description, favorite, and/or charts." },
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
  if (body.favorite !== undefined) update.favorite = body.favorite;
  if (body.charts !== undefined) {
    update.charts = body.charts.map((c, i) => ({
      order: c.order ?? i,
      title: c.title,
      spec: c.spec,
      // Only include optional fields when explicitly set so we don't
      // write a null over existing data when the caller didn't touch
      // them. sourceSql + dataMapping are persisted intact so reorder
      // and resize on a filter-driven chart don't silently downgrade
      // it to static.
      ...(c.colSpan ? { colSpan: c.colSpan } : {}),
      ...(c.sourceSql ? { sourceSql: c.sourceSql } : {}),
      ...(c.dataMapping !== undefined ? { dataMapping: c.dataMapping } : {}),
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
