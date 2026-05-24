import type { NotificationPayload, TeamsChannelConfig } from "./types";

/**
 * Microsoft Teams incoming-webhook delivery. Teams supports two
 * payload formats: the legacy MessageCard (`@type: MessageCard`)
 * and modern Adaptive Cards. We use MessageCard for v1 — wider
 * compatibility, especially for older Teams desktop clients.
 *
 * If Microsoft fully retires MessageCard (the "Office 365 Connector"
 * format), the migration is a single payload-shape swap inside
 * this function. Public API surface stays the same.
 */
export async function sendTeams(
  config: TeamsChannelConfig,
  payload: NotificationPayload
): Promise<void> {
  const body = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    // Themes Teams' top accent bar — red because this is a fired
    // alert. (Could colour-code by category instead, but red signals
    // "needs attention" most clearly.)
    themeColor: "EF4444",
    summary: `Insight fired: ${payload.title}`,
    sections: [
      {
        activityTitle: `🚨 ${payload.title}`,
        activitySubtitle: payload.description,
        facts: [
          { name: "Category", value: payload.category },
          { name: "Trigger", value: payload.ruleSummary },
          { name: "Current", value: String(payload.currentValue) },
          {
            name: "Previous",
            value: payload.previousValue == null ? "—" : String(payload.previousValue),
          },
        ],
        markdown: true,
      },
    ],
    potentialAction: [
      {
        "@type": "OpenUri",
        name: "View in Liveli",
        targets: [{ os: "default", uri: payload.insightsUrl }],
      },
    ],
  };

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Teams webhook ${res.status}: ${text || res.statusText}`);
  }
}
