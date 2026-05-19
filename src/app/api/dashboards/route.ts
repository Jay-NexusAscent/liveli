import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, dashboardsIn } from "@/lib/firestore";

export const runtime = "nodejs";

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
  const snap = await dashboardsIn(ctx.clientId, ctx.workspaceId)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return Response.json({ items });
}
