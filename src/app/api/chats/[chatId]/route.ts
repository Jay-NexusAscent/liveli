import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, chatsIn, messagesIn } from "@/lib/firestore";

export const runtime = "nodejs";

const RenameBody = z.object({
  title: z.string().min(1).max(120),
});

/**
 * PATCH /api/chats/[chatId] — rename a chat.
 *
 * Only updates the title field; doesn't touch messages or createdAt.
 * Workspace-scoped via the document path.
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ chatId: string }> }
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

  const { chatId } = await context.params;
  const body = RenameBody.parse(await req.json());

  await dbReady();
  const ref = chatsIn(ctx.clientId, ctx.workspaceId).doc(chatId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }
  await ref.update({ title: body.title });
  return Response.json({ ok: true });
}

/**
 * DELETE /api/chats/[chatId] — delete a chat AND all its messages.
 *
 * Firestore doesn't cascade subcollection deletes — we have to fetch
 * the messages subcollection and delete each doc, then the parent
 * chat doc. Workspace-scoped.
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ chatId: string }> }
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

  const { chatId } = await context.params;

  await dbReady();
  const chatRef = chatsIn(ctx.clientId, ctx.workspaceId).doc(chatId);
  const snap = await chatRef.get();
  if (!snap.exists) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  // Delete messages subcollection in batches of 100.
  const msgsRef = messagesIn(ctx.clientId, ctx.workspaceId, chatId);
  while (true) {
    const batch = await msgsRef.limit(100).get();
    if (batch.empty) break;
    await Promise.all(batch.docs.map((d) => d.ref.delete()));
    if (batch.size < 100) break;
  }
  await chatRef.delete();
  return Response.json({ ok: true });
}
