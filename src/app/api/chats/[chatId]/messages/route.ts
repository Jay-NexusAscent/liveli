import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, chatsIn, messagesIn } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * GET /api/chats/[chatId]/messages — load the messages of a chat
 * for client-side resume.
 *
 * Returns messages in chronological order. Each message includes:
 *   - role: "user" | "assistant"
 *   - content: the assembled text
 *   - toolBlocks: persisted tool_use / tool_result / text blocks
 *     (input/content stringified, as written by agent.ts at persist
 *     time; the client parses on render)
 *
 * Workspace-scoped via the chat path. Caps at 200 messages — same
 * order of magnitude as the live agent's history-load limit.
 */
export async function GET(
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
  const chatSnap = await chatRef.get();
  if (!chatSnap.exists) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const msgSnap = await messagesIn(ctx.clientId, ctx.workspaceId, chatId)
    .orderBy("createdAt", "asc")
    .limit(200)
    .get();
  const messages = msgSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const chat = chatSnap.data() as { title?: string };

  return Response.json({
    chat: { id: chatId, title: chat.title ?? "Untitled chat" },
    messages,
  });
}
