import type { NotificationPayload, SlackChannelConfig } from "./types";

/**
 * Slack incoming-webhook delivery using Block Kit. The
 * webhookUrl already encodes the destination channel — we just POST
 * a Blocks payload to it.
 *
 * Block Kit is preferred over `text`-only payloads because it
 * renders richer (header, fields, button-as-link) and degrades
 * gracefully — Slack uses the `text` field as a notification
 * fallback when blocks can't render (e.g. mobile push previews).
 *
 * Throws on non-2xx with a Slack-relevant message — those bubble up
 * to `lastSendError` on the channel doc.
 */
export async function sendSlack(
  config: SlackChannelConfig,
  payload: NotificationPayload
): Promise<void> {
  const change = formatChange(payload.currentValue, payload.previousValue);
  const body = {
    // Fallback text used for push notifications + accessibility.
    text: `🚨 Insight fired: ${payload.title}${change ? ` (${change})` : ""}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🚨 ${payload.title}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: payload.description },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Category:*\n${payload.category}` },
          { type: "mrkdwn", text: `*Trigger:*\n${payload.ruleSummary}` },
          { type: "mrkdwn", text: `*Current:*\n${payload.currentValue}` },
          {
            type: "mrkdwn",
            text: `*Previous:*\n${payload.previousValue ?? "—"}`,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View in Liveli" },
            url: payload.insightsUrl,
            style: "primary",
          },
        ],
      },
    ],
  };

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Slack returns "invalid_payload" / "channel_not_found" / etc.
    // in the response body for webhook errors. Surface that text so
    // the channel-config UI can show a useful error.
    const text = await res.text().catch(() => "");
    throw new Error(
      `Slack webhook ${res.status}: ${text || res.statusText}`
    );
  }
}

/**
 * Format a "previous → current" change for the fallback text. Empty
 * string when there's no previous value (first eval of a value_*
 * rule). Kept out of the block payload — Block Kit already shows
 * the values in fields.
 */
function formatChange(current: number, previous: number | null): string {
  if (previous == null) return "";
  if (previous === 0) return `${previous} → ${current}`;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${previous} → ${current}, ${sign}${pct.toFixed(1)}%`;
}
