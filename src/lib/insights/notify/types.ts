/**
 * Alert channel types — the persisted shape of a workspace's
 * notification destinations. Each channel = one delivery target
 * (Slack workspace, Teams team, Telegram chat, etc.). Insights fan
 * out to every enabled channel when they transition idle → fired.
 *
 * Why a single union-typed collection rather than per-type
 * collections (slackChannels, teamsChannels, etc.):
 *   - Reading "all channels for this workspace" is the hot path —
 *     called on every fired insight. One collection = one Firestore
 *     query.
 *   - The dispatcher routes per-channel-type via a switch on `type`;
 *     the additional fields per type are tiny.
 *
 * Secret handling: webhookUrl, botToken etc. are stored in plain
 * Firestore. Same risk model as the BigQuery service account
 * credentials we already store behind workspace auth. KMS encryption
 * is a v2 hardening (filed as a Linear follow-up).
 */

/**
 * Channel discriminator. Maps to per-channel formatters in
 * src/lib/insights/notify/{slack,teams,telegram,webhook}.ts.
 *
 * Why "slack" and "teams" are separate even though they share the
 * incoming-webhook pattern: their message payload shapes are
 * incompatible (Slack Block Kit vs Teams MessageCard). One
 * formatter per type keeps that asymmetry explicit instead of
 * branching inside a shared sender.
 */
export type AlertChannelType = "slack" | "teams" | "telegram" | "webhook";

export const ALERT_CHANNEL_TYPES: readonly AlertChannelType[] = [
  "slack",
  "teams",
  "telegram",
  "webhook",
] as const;

/**
 * Per-type config payloads. Discriminated union — each type has its
 * own required fields. Webhook URLs and bot tokens are sensitive;
 * they're never returned in GET responses (the redact() helper in
 * notify/index.ts masks them).
 */
export interface SlackChannelConfig {
  type: "slack";
  /** Full Slack incoming-webhook URL (https://hooks.slack.com/services/T../B../...). */
  webhookUrl: string;
}

export interface TeamsChannelConfig {
  type: "teams";
  /** Microsoft Teams incoming webhook URL — created in a Teams channel via "Workflows" or the legacy "Incoming Webhook" connector. */
  webhookUrl: string;
}

export interface TelegramChannelConfig {
  type: "telegram";
  /** Bot token from @BotFather (e.g. "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"). */
  botToken: string;
  /** Chat ID — can be a user, group, or channel id. Negative for groups/channels. */
  chatId: string;
}

export interface WebhookChannelConfig {
  type: "webhook";
  /** Generic JSON POST target. */
  webhookUrl: string;
  /** Optional Bearer token — sent as `Authorization: Bearer <secret>`. */
  bearerSecret?: string;
}

export type AlertChannelConfig =
  | SlackChannelConfig
  | TeamsChannelConfig
  | TelegramChannelConfig
  | WebhookChannelConfig;

/**
 * Firestore document shape. `config` is the type-specific payload
 * above; the discriminator is also lifted to the top-level `type`
 * field so list endpoints can filter without parsing config.
 *
 * `enabled` lets a customer pause a channel without deleting it —
 * useful for "Slack down, route to webhook for a day" workflows.
 */
export interface AlertChannel {
  id: string;
  type: AlertChannelType;
  /** User-facing label, e.g. "Engineering Slack". */
  name: string;
  enabled: boolean;
  config: AlertChannelConfig;

  /** When the most recent send succeeded. */
  lastSentAt?: { _seconds: number; _nanoseconds: number } | null;
  /** Populated when the most recent send failed. Cleared on next successful send. */
  lastSendError?: string | null;

  createdBy: string;
  createdAt: { _seconds: number; _nanoseconds: number };
  updatedAt?: { _seconds: number; _nanoseconds: number } | null;
}

/**
 * Public (redacted) view of a channel — what list endpoints return
 * to the client. Webhook URLs are masked so a teammate can't
 * exfiltrate the full URL by reading the API.
 *
 * Why client doesn't need the full URL: editing a channel re-issues
 * the URL via PATCH (caller supplies the new value); the GET path
 * is read-only for purposes of "is this still configured" / "send a
 * test from the UI".
 */
export interface AlertChannelPublic {
  id: string;
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  /** Redacted preview, e.g. "https://hooks.slack.com/services/T###/B###/###" with secret segments masked. */
  configPreview: string;
  lastSentAt?: { _seconds: number; _nanoseconds: number } | null;
  lastSendError?: string | null;
  createdAt: { _seconds: number; _nanoseconds: number };
  updatedAt?: { _seconds: number; _nanoseconds: number } | null;
}

/**
 * Compact payload the per-channel formatters receive. Decouples the
 * formatter signature from the full Insight Firestore shape — keeps
 * formatters easy to unit-test with synthetic data, and means the
 * "test send" endpoint can ship a fake payload without faking the
 * full Insight object graph.
 */
export interface NotificationPayload {
  insightId: string;
  title: string;
  description: string;
  category: "Sales" | "Customer" | "Operational" | "Growth";
  currentValue: number;
  previousValue: number | null;
  ruleSummary: string;
  /** Direct link to the insights tab, e.g. https://app.liveli.co.uk/insights. */
  insightsUrl: string;
}
