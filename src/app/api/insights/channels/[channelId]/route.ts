import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { alertChannelsIn, dbReady } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * Partial-update body. v1 supports flipping `enabled` and renaming.
 * Secret rotation (changing webhookUrl / botToken) deliberately not
 * supported here yet — that'd need re-validation of the new value
 * and isn't worth the surface until customers ask. Workaround: delete
 * + recreate with the new value.
 */
const PatchBody = z.object({
  enabled: z.boolean().optional(),
  name: z.string().min(1).max(80).optional(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ channelId: string }> }
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

  const { channelId } = await context.params;

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  if (body.enabled === undefined && body.name === undefined) {
    return Response.json(
      { error: "No editable fields supplied. Pass `enabled` and/or `name`." },
      { status: 400 }
    );
  }

  await dbReady();
  const ref = alertChannelsIn(ctx.clientId, ctx.workspaceId).doc(channelId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Channel not found" }, { status: 404 });
  }

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (body.enabled !== undefined) update.enabled = body.enabled;
  if (body.name !== undefined) update.name = body.name;

  await ref.update(update);
  return Response.json({ ok: true });
}

/**
 * Delete a channel. Workspace-scoped — request authenticated to
 * workspace A can't delete channels owned by workspace B. Returns
 * 404 for missing OR mis-scoped ids (no existence leak).
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ channelId: string }> }
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

  const { channelId } = await context.params;

  await dbReady();
  const ref = alertChannelsIn(ctx.clientId, ctx.workspaceId).doc(channelId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Channel not found" }, { status: 404 });
  }
  await ref.delete();
  return Response.json({ ok: true });
}
