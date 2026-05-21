import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, chartsIn } from "@/lib/firestore";

export const runtime = "nodejs";

const PatchBody = z.object({
  title: z.string().min(1).max(120).optional(),
  spec: z.unknown().optional(),
});

/**
 * Update a saved chart's title and/or spec. Either field is optional;
 * fields omitted from the body are left as-is. Workspace-scoped.
 *
 * Used by the Dashboards page when the user renames a chart, and by
 * the agent's `update_chart` tool when an Edit-via-chat session
 * applies a model-generated spec change.
 */
export async function PATCH(
  req: Request,
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
  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }
  if (body.title === undefined && body.spec === undefined) {
    return Response.json({ error: "Provide title and/or spec." }, { status: 400 });
  }

  await dbReady();
  const ref = chartsIn(ctx.clientId, ctx.workspaceId).doc(chartId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Chart not found" }, { status: 404 });
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (body.title !== undefined) update.title = body.title;
  if (body.spec !== undefined) update.spec = body.spec;
  await ref.update(update);
  return Response.json({ ok: true });
}

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
