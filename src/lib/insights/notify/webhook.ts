import type { NotificationPayload, WebhookChannelConfig } from "./types";

/**
 * Generic JSON-POST webhook. The customer supplies a URL and we
 * POST the full NotificationPayload as JSON.
 *
 * Why this exists alongside Slack/Teams: power-user route — lets
 * customers route to PagerDuty Events API, n8n / Make /
 * Zapier flows, internal ticketing systems, etc. without us
 * having to write per-provider formatters.
 *
 * Auth: optional Bearer secret sent as
 * `Authorization: Bearer <secret>`. Stored alongside the URL in
 * Firestore (same risk model — see notify/types.ts).
 */
export async function sendWebhook(
  config: WebhookChannelConfig,
  payload: NotificationPayload
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Liveli-Insights/1.0",
  };
  if (config.bearerSecret) {
    headers.Authorization = `Bearer ${config.bearerSecret}`;
  }

  // Payload shape is documented for customers; once any customer
  // wires this up we need to keep it backward-compatible.
  // Adding fields is fine; renaming or removing breaks integrations.
  const body = {
    event: "insight_fired",
    insight: {
      id: payload.insightId,
      title: payload.title,
      description: payload.description,
      category: payload.category,
      current_value: payload.currentValue,
      previous_value: payload.previousValue,
      rule_summary: payload.ruleSummary,
      url: payload.insightsUrl,
    },
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Truncate response body — some webhooks (Sentry, n8n) return
    // verbose HTML on error. 200 chars is enough context.
    const snippet = text.slice(0, 200);
    throw new Error(
      `Webhook ${res.status}: ${snippet || res.statusText}`
    );
  }
}
