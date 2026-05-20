import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, chatsIn } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * GET /api/chats — list the workspace's chats, most-recent first.
 *
 * Returns just the metadata (id, title, createdAt). Messages are
 * loaded on-demand via /api/chats/[chatId]/messages when the user
 * opens a specific chat. Keeps the list endpoint cheap when a
 * workspace has hundreds of past chats.
 */
export async function GET() {
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
  const snap = await chatsIn(ctx.clientId, ctx.workspaceId)
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();
  const items = snap.docs.map((d) => {
    const data = d.data() as { title?: string; createdAt?: { _seconds?: number } };
    return {
      id: d.id,
      title: data.title ?? "Untitled chat",
      createdAt: data.createdAt ?? null,
    };
  });
  return Response.json({ items });
}
