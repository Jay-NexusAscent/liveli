import { FieldValue } from "@google-cloud/firestore";
import { alertChannelsIn } from "@/lib/firestore";
import { describeRule } from "@/lib/insights/evaluate";
import type { Insight } from "@/lib/insights/types";
import { sendSlack } from "./slack";
import { sendTeams } from "./teams";
import { sendTelegram } from "./telegram";
import { sendWebhook } from "./webhook";
import type {
  AlertChannel,
  AlertChannelConfig,
  NotificationPayload,
} from "./types";

export type {
  AlertChannel,
  AlertChannelConfig,
  AlertChannelPublic,
  AlertChannelType,
  NotificationPayload,
  SlackChannelConfig,
  TeamsChannelConfig,
  TelegramChannelConfig,
  WebhookChannelConfig,
} from "./types";
export { ALERT_CHANNEL_TYPES } from "./types";

/**
 * Resolve the customer-facing URL for the insights tab. Used by all
 * formatters as the "View in Liveli" CTA in the alert message.
 *
 * Pulled from the env var so dev / preview / prod all link to the
 * right host. Falls back to liveli.co.uk root when unset — better
 * than emitting a localhost link in production.
 */
function insightsUrl(): string {
  const base = process.env.APP_URL ?? "https://app.liveli.co.uk";
  return `${base.replace(/\/$/, "")}/insights`;
}

/**
 * Fan-out: send one insight's "just fired" notification to every
 * enabled channel in the workspace. Per-channel failures are
 * isolated — one Slack webhook 500-ing doesn't block Teams or
 * Telegram. Failures write `lastSendError` on the channel doc so
 * the customer can see them on /insights/channels.
 *
 * Returns nothing — the caller (evaluateInsight) is fire-and-forget;
 * we don't want a slow Slack endpoint blocking the eval response.
 *
 * Why a separate function rather than inlining in evaluateInsight:
 *   - Keeps evaluate.ts focused on the rule / persistence logic.
 *   - Lets the test-send endpoint reuse the per-channel send paths
 *     with synthetic NotificationPayloads.
 */
export async function notifyInsightFired(
  insight: Insight,
  ctx: { clientId: string; workspaceId: string }
): Promise<void> {
  const snap = await alertChannelsIn(ctx.clientId, ctx.workspaceId)
    .where("enabled", "==", true)
    .get();
  if (snap.empty) return;

  const payload: NotificationPayload = {
    insightId: insight.id,
    title: insight.title,
    description: insight.description,
    category: insight.category,
    currentValue: insight.currentValue ?? 0,
    previousValue: insight.previousValue,
    ruleSummary: describeRule(insight.rule),
    insightsUrl: insightsUrl(),
  };

  // Sequential, not Promise.all — keeps the eval log readable when
  // multiple channels fail with different errors. Per-channel HTTP
  // takes <1s typically; 4 channels = 4s tops.
  for (const doc of snap.docs) {
    const ch = { id: doc.id, ...doc.data() } as AlertChannel;
    try {
      await sendForChannel(ch.config, payload);
      await doc.ref.update({
        lastSentAt: FieldValue.serverTimestamp(),
        lastSendError: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log to channel doc — visible on /insights/channels.
      await doc.ref
        .update({
          lastSendError: message,
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => {
          /* Firestore unavailable — already in a bad state, no recovery here */
        });
      console.warn("[insights/notify] channel send failed", {
        channelId: ch.id,
        type: ch.type,
        error: message,
      });
    }
  }
}

/**
 * Dispatch one channel's send to the right formatter. Exported so
 * the /api/insights/channels/[id]/test endpoint can call it
 * directly with a synthetic payload.
 */
export async function sendForChannel(
  config: AlertChannelConfig,
  payload: NotificationPayload
): Promise<void> {
  switch (config.type) {
    case "slack":
      return sendSlack(config, payload);
    case "teams":
      return sendTeams(config, payload);
    case "telegram":
      return sendTelegram(config, payload);
    case "webhook":
      return sendWebhook(config, payload);
  }
}

/**
 * Mask sensitive bits of a channel config for the public list view.
 * Webhook URLs: keep enough of the URL that the customer can tell
 * which channel they wired up ("hooks.slack.com" prefix etc.) but
 * obscure the secret path segments. Tokens: redact entirely.
 *
 * Why redact at the API layer rather than not-storing-secrets-at-all:
 * we need the full URL to send the actual notification. The
 * alternative — fetching from Secret Manager on every send — adds
 * latency and a new dependency for marginal security gain at this
 * tier. KMS encryption at rest is a v2 hardening (filed as a Linear
 * follow-up).
 */
export function redactChannelConfig(config: AlertChannelConfig): string {
  switch (config.type) {
    case "slack":
    case "teams":
    case "webhook":
      return redactUrl(config.webhookUrl);
    case "telegram":
      return `bot ${maskMiddle(config.botToken, 6, 4)} → chat ${config.chatId}`;
  }
}

/**
 * Show the host + a hint of path, mask the secret segments. Input
 * "https://hooks.slack.com/services/T01A2B3/B04C5D6/abc123xyz789"
 * becomes "https://hooks.slack.com/services/T01<mask>/B04<mask>/abc<mask>"
 * where <mask> is three asterisks. Doc literal omits the asterisks
 * to avoid closing this JSDoc block early.
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const masked = segments
      .map((s) => (s.length > 4 ? s.slice(0, 3) + "***" : s))
      .join("/");
    return `${u.protocol}//${u.host}/${masked}`;
  } catch {
    // Not a parseable URL — just show its tail.
    return maskMiddle(url, 8, 4);
  }
}

function maskMiddle(s: string, keepStart: number, keepEnd: number): string {
  if (s.length <= keepStart + keepEnd) return s;
  return `${s.slice(0, keepStart)}***${s.slice(-keepEnd)}`;
}
