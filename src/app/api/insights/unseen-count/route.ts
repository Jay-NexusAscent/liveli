import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, insightsIn, userDoc } from "@/lib/firestore";
import type { Insight } from "@/lib/insights/types";

export const runtime = "nodejs";

/**
 * Count of FIRED insights whose `firedAt > user.insightsLastSeenAt`.
 * Drives the red bubble next to the "Insights" sidebar nav item.
 *
 * Polled by the sidebar badge component every 60s + on tab focus.
 * Kept dirt-cheap: no full insight payload, no SQL re-eval — just
 * iterate fired insights in the workspace and compare timestamps
 * against the user's last-seen marker.
 *
 * Per-USER not per-workspace: if Alice acknowledges the alert,
 * Bob's bubble persists until Bob also visits the tab.
 *
 * When insightsLastSeenAt is missing (new user / never visited),
 * treat as -Infinity so every existing fired insight is "unseen".
 * That gives new joiners a "here's what the team's been alerting on"
 * intro on first visit — better than blank.
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

  const [insightsSnap, userSnap] = await Promise.all([
    insightsIn(ctx.clientId, ctx.workspaceId)
      .where("status", "==", "fired")
      .get(),
    userDoc(ctx.userId).get(),
  ]);

  // Pull lastSeenAt as a unix-seconds number for comparison. The
  // field is stored as a Firestore Timestamp; .toMillis() handles
  // that. Undefined → -Infinity (everything counts).
  const lastSeenMs = (() => {
    if (!userSnap.exists) return -Infinity;
    const data = userSnap.data() as { insightsLastSeenAt?: { toMillis(): number } };
    return data.insightsLastSeenAt?.toMillis?.() ?? -Infinity;
  })();

  let unseenCount = 0;
  for (const doc of insightsSnap.docs) {
    const ins = doc.data() as Insight;
    const firedAtMs =
      typeof ins.firedAt === "object" && ins.firedAt && "_seconds" in ins.firedAt
        ? ins.firedAt._seconds * 1000
        : null;
    if (firedAtMs == null) continue;
    if (firedAtMs > lastSeenMs) unseenCount += 1;
  }

  return Response.json({ count: unseenCount });
}
