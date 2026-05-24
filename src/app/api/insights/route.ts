import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, insightsIn } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * List all insights for the current workspace, newest-fired-first then
 * newest-created. The UI splits the response into "Active alerts"
 * (status === "fired") and "Tracking" (status === "idle") sections,
 * but server-side we don't pre-split — keeping it one list avoids
 * a duplicate query and lets the client decide ordering nuance.
 *
 * Ordered by createdAt desc to match how the rest of the workspace
 * surface (dashboards, charts) returns items. Sorting by status
 * happens client-side.
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
  const snap = await insightsIn(ctx.clientId, ctx.workspaceId)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return Response.json({ items });
}
