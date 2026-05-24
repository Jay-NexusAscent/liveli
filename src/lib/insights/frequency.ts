/**
 * Frequency enum + helpers for insight evaluation schedules.
 *
 * Why a CLOSED enum (not arbitrary minutes):
 *   - The Cloud Scheduler binding (LIVELI-126) needs to know every
 *     legal frequency up front so it can create one Scheduler entry
 *     per (workspace, frequency) bucket. Arbitrary minutes = one
 *     scheduler entry per insight, which scales poorly.
 *   - 7 fixed buckets gives the customer real choice without scheduling
 *     complexity. Most use-cases fit 1h / 6h / 24h; the 5m / 15m
 *     options exist for high-frequency ops alerts.
 *
 * Why the buckets stop at 24h (not weekly/monthly):
 *   - Anything longer-running than "today" should probably be a
 *     dashboard, not an alert. Insights are inherently "tell me when
 *     something CHANGES" — the cadence matches that frame.
 *
 * Tier gating: the cheapest tiers should be capped at the slowest
 * frequencies; faster cadence is a paid feature. Today
 * `maxFrequencyForTier()` returns "5m" for all tiers (no gate) — that
 * changes when LIVELI-125 / pricing lands.
 */

export type InsightFrequency = "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";

export const FREQUENCY_VALUES: readonly InsightFrequency[] = [
  "5m",
  "15m",
  "30m",
  "1h",
  "6h",
  "12h",
  "24h",
] as const;

/**
 * Sensible default for newly-created insights. Frequent enough to
 * surface most signals same-day; infrequent enough to keep
 * BigQuery scan costs predictable per workspace.
 */
export const DEFAULT_FREQUENCY: InsightFrequency = "1h";

/**
 * Human-readable labels for the frequency picker. Single source of
 * truth — the UI imports this rather than open-coding strings.
 */
export const FREQUENCY_LABELS: Record<InsightFrequency, string> = {
  "5m": "Every 5 minutes",
  "15m": "Every 15 minutes",
  "30m": "Every 30 minutes",
  "1h": "Every hour",
  "6h": "Every 6 hours",
  "12h": "Every 12 hours",
  "24h": "Daily",
};

/**
 * Numeric minutes per frequency. Used by the scheduler binding (when
 * it lands) to compute next-fire times. Also used in the UI for
 * sorting by "frequency tightness".
 */
export const FREQUENCY_MINUTES: Record<InsightFrequency, number> = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "6h": 360,
  "12h": 720,
  "24h": 1440,
};

/**
 * Tightest (most frequent) allowed schedule for a given pricing tier.
 *
 * Today this is a stub — returns "5m" (no gate) for every tier so we
 * can dogfood high-frequency alerts in dev. When tier gating ships
 * (alongside LIVELI-125 caps), replace the body with the real tier
 * lookup; every caller already routes through this function so the
 * gate becomes a one-spot change.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function maxFrequencyForTier(_tier: string | undefined): InsightFrequency {
  // Placeholder — see file header. When LIVELI-125 ships, switch on
  // the tier and return one of:
  //   free / trial: "24h" (daily only)
  //   starter:      "1h"
  //   growth:       "15m"
  //   enterprise:   "5m"
  return "5m";
}

/**
 * Type guard / coercion for arbitrary inputs (e.g. PATCH body).
 * Returns null when the input isn't a valid frequency string, which
 * lets callers reject the request with a useful error.
 */
export function asFrequency(v: unknown): InsightFrequency | null {
  if (typeof v !== "string") return null;
  return (FREQUENCY_VALUES as readonly string[]).includes(v)
    ? (v as InsightFrequency)
    : null;
}

/**
 * Clamp a requested frequency to the tier's maximum. When the
 * requested cadence is tighter than the tier allows, returns the
 * tier max (the user gets the best schedule we can give them rather
 * than an error). When the request is omitted, returns the default.
 *
 * Today maxFrequencyForTier is a stub returning "5m" for every tier,
 * so this function is effectively a "use default if undefined"
 * passthrough. The call-sites (save_insight handler + POST
 * /api/insights handler + PATCH endpoint) exist so the gate is
 * already wired when LIVELI-125 lands the real tier lookup.
 */
export function clampFrequency(
  requested: InsightFrequency | undefined,
  tier: string | undefined
): InsightFrequency {
  const want = requested ?? DEFAULT_FREQUENCY;
  const max = maxFrequencyForTier(tier);
  if (FREQUENCY_MINUTES[want] < FREQUENCY_MINUTES[max]) {
    return max;
  }
  return want;
}
