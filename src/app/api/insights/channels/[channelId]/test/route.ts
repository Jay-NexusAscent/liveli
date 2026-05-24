import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { alertChannelsIn, dbReady } from "@/lib/firestore";
import { sendForChannel } from "@/lib/insights/notify";
import type { AlertChannel, NotificationPayload } from "@/lib/insights/notify";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Send a TEST notification through a single channel. Uses a synthetic
 * NotificationPayload — the customer sees a clearly-test-flavoured
 * message in their Slack / Teams / etc., proving the integration is
 * wired correctly before any real insight fires.
 *
 * Critical because customers configure these things once and forget.
 * Without a test button, the first time they find out their webhook
 * is wrong is when a real alert disappears into the void.
 *
 * Success / failure surfaces via lastSentAt / lastSendError on the
 * channel doc, AND in the response body so the UI can show an
 * immediate "Test sent ✓" / "Test failed: <message>" banner.
 */
export async function POST(
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
  const channel = { id: snap.id, ...snap.data() } as AlertChannel;

  const base = process.env.APP_URL ?? "https://app.liveli.co.uk";
  const payload: NotificationPayload = {
    insightId: "test",
    title: "Test alert from Liveli",
    description:
      "If you can see this message, your alert channel is wired up correctly. Real alerts will look like this.",
    category: "Operational",
    currentValue: 42,
    previousValue: 40,
    ruleSummary: "(test payload — not a real alert)",
    insightsUrl: `${base.replace(/\/$/, "")}/insights`,
  };

  try {
    await sendForChannel(channel.config, payload);
    await ref.update({
      lastSentAt: FieldValue.serverTimestamp(),
      lastSendError: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ref.update({
      lastSendError: message,
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Return 200 with ok:false so the UI can show the message inline
    // rather than treating it as a request-level failure (which would
    // surface as a generic alert).
    return Response.json({ ok: false, error: message });
  }
}
