import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, userDoc } from "@/lib/firestore";

export const runtime = "nodejs";

/**
 * Read the current user's insightsLastSeenAt marker. Returned as
 * `lastSeenMs` (milliseconds since epoch) so the client can compare
 * directly to insight.firedAt._seconds * 1000.
 *
 * Returns null when the user has never opened /insights (or their
 * user doc doesn't exist — Clerk webhook lag on first sign-in).
 * Page treats null as 0 → all fired insights count as "new".
 *
 * Separate from POST because GET should not have side effects.
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
  const snap = await userDoc(ctx.userId).get();
  if (!snap.exists) {
    return Response.json({ lastSeenMs: null });
  }
  const data = snap.data() as { insightsLastSeenAt?: { toMillis(): number } };
  const lastSeenMs = data.insightsLastSeenAt?.toMillis?.() ?? null;
  return Response.json({ lastSeenMs });
}


/**
 * Mark all fired insights as "seen" by stamping the user doc's
 * `insightsLastSeenAt` field. Called by /insights page about 1.2s
 * after mount — long enough for the "newly fired" highlight to be
 * visible to the user, short enough that they don't notice the
 * delay.
 *
 * Why a dedicated endpoint rather than reusing a generic user-doc
 * patch: keeps the field a server-set timestamp (rejecting
 * client-supplied dates avoids race / spoofing of the bubble state).
 * Also makes the audit log readable: "user X stamped insights-seen
 * at Y" reads as a single event.
 *
 * Uses `set` with `merge: true` so it works for new users whose
 * doc may not exist yet (Clerk webhook can lag the first sign-in).
 */
export async function POST() {
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
  await userDoc(ctx.userId).set(
    { insightsLastSeenAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return Response.json({ ok: true });
}
