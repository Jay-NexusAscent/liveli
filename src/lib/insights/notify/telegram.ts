import type { NotificationPayload, TelegramChannelConfig } from "./types";

/**
 * Telegram Bot API delivery via sendMessage. Plain markdown body
 * with a link button — Telegram's MarkdownV2 mode requires
 * aggressive escaping (every `.` and `-` is reserved); we use the
 * legacy "Markdown" mode instead which is more forgiving but a
 * little less rich.
 *
 * The bot must already be a member of the target chat (group / channel)
 * or have started a DM with the user, otherwise sendMessage returns
 * 400 / "chat not found" / "bot was blocked" — those error strings
 * surface to the channel-config UI via lastSendError.
 */
export async function sendTelegram(
  config: TelegramChannelConfig,
  payload: NotificationPayload
): Promise<void> {
  const change = formatChange(payload.currentValue, payload.previousValue);
  const text =
    `🚨 *${escapeMarkdown(payload.title)}*\n\n` +
    `${escapeMarkdown(payload.description)}\n\n` +
    `_${escapeMarkdown(payload.ruleSummary)}_\n` +
    `Current: \`${payload.currentValue}\`${change ? ` (${change})` : ""}\n\n` +
    `[View in Liveli](${payload.insightsUrl})`;

  const url = `https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    // Telegram's error response is JSON with `description`. Surface it.
    const json = await res
      .json()
      .catch(() => ({}) as { description?: string });
    throw new Error(
      `Telegram ${res.status}: ${json.description ?? res.statusText}`
    );
  }
}

/**
 * Escape characters that Markdown mode treats as formatting. Limited
 * set — `_`, `*`, backtick, `[` — vs MarkdownV2's full escape list.
 * The customer's insight titles + descriptions are unlikely to
 * include heavy formatting characters, so this keeps the formatter
 * simple.
 */
function escapeMarkdown(s: string): string {
  return s.replace(/([_*`[\]])/g, "\\$1");
}

function formatChange(current: number, previous: number | null): string {
  if (previous == null) return "";
  if (previous === 0) return `from \`${previous}\``;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}% vs \`${previous}\``;
}
