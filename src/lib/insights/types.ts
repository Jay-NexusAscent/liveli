/**
 * Insight type definitions — LIVELI-91 (Model B: live-evaluated alerts).
 *
 * An Insight is a SQL query + a rule that fires when the query's value
 * crosses a threshold. The pattern reuses what we built for filter-
 * driven charts (LIVELI-122): user-supplied SQL stored as text,
 * re-runnable via safeQuery, output mapped into a known shape.
 *
 * Contract for sourceSql:
 *   - Must return EXACTLY one row with EXACTLY one numeric column.
 *   - The first column of the first row is the "value" being tracked.
 *   - Column name is ignored — only the value matters.
 *   - Non-numeric values cause evaluation to error.
 *
 * Evaluation lifecycle:
 *   1. save_insight (agent tool) runs the SQL once at create time.
 *      Result becomes `currentValue`; `previousValue` stays null.
 *      Status is computed from the rule. For value_above / value_below
 *      this might fire immediately; for change_pct_* it can't (no
 *      baseline yet) — those start `idle`.
 *   2. Re-evaluation (manual button or Cloud Scheduler cron) re-runs
 *      the SQL: previousValue := currentValue, currentValue := fresh.
 *      Rule re-applies, status updates, firedAt timestamps the
 *      transition idle→fired.
 *
 * Persistence layout:
 *   clients/<C>/workspaces/<W>/insights/<insightId>
 */

/**
 * UI category — drives card colour + filtering. Same enum the original
 * mock-data UI used so the cosmetic layer doesn't have to re-think
 * styling. Kept intentionally short — more categories adds visual
 * noise without much signal.
 */
export type InsightCategory = "Sales" | "Customer" | "Operational" | "Growth";

export const INSIGHT_CATEGORIES: readonly InsightCategory[] = [
  "Sales",
  "Customer",
  "Operational",
  "Growth",
] as const;

/**
 * Rule kinds for v1. Kept deliberately small — anything more nuanced
 * (rolling averages, anomaly detection, multi-dimensional baselines)
 * is a v2 problem and would explode the agent's authoring surface.
 *
 *   - change_pct_above: fire when current rose by > threshold % from previous.
 *     Use for: "AOV jumped" / "signups spiked" type alerts.
 *   - change_pct_below: fire when current dropped by > threshold % from previous.
 *     Use for: "revenue dropped" / "engagement dipped" alerts.
 *   - value_above: fire when current > threshold (absolute number).
 *     Use for: "errors per hour > 50" / "queue depth > 100" alerts.
 *   - value_below: fire when current < threshold (absolute number).
 *     Use for: "weekly signups < 20" / "uptime < 99%" alerts.
 */
export type RuleType =
  | "change_pct_above"
  | "change_pct_below"
  | "value_above"
  | "value_below";

export const RULE_TYPES: readonly RuleType[] = [
  "change_pct_above",
  "change_pct_below",
  "value_above",
  "value_below",
] as const;

export interface InsightRule {
  type: RuleType;
  /**
   * For change_pct_* rules this is a percent (5 = 5%).
   * For value_* rules this is an absolute number in the unit of the
   * tracked value. Storing as a single number keeps the agent schema
   * flat (Gemini-friendly) — the rule type alone disambiguates the
   * unit.
   */
  threshold: number;
}

/**
 * Alert state. Transitions are driven by the evaluator —
 * idle <-> fired purely based on the most recent evaluation's rule
 * outcome. No "acknowledge" state in v1; the user just deletes
 * insights that are no longer interesting.
 */
export type InsightStatus = "idle" | "fired";

/**
 * Firestore document shape. Keeps optional fields explicit so we can
 * write byte-clean docs (no `undefined` round-tripping into Firestore
 * which throws).
 */
export interface Insight {
  id: string;
  title: string;
  description: string;
  category: InsightCategory;

  /** Single-row, single-numeric-column SELECT. See top-of-file contract. */
  sourceSql: string;
  /** Display-only label, e.g. "Postgres Demo" — the source connector. */
  sourceConnector?: string;

  rule: InsightRule;

  /**
   * How often this insight is evaluated. Discrete bucket from
   * FREQUENCY_VALUES so the Cloud Scheduler binding (LIVELI-126) can
   * group insights by frequency and dispatch them in batches.
   * Optional in the type because pre-LIVELI-91-Phase-2 docs may not
   * have it yet — readers should default to DEFAULT_FREQUENCY (24h)
   * when missing.
   */
  frequency?: import("./frequency").InsightFrequency;

  /**
   * Per-insight channel subscription. When undefined or empty, fire
   * notifications fan out to EVERY enabled alert channel in the
   * workspace (the original behaviour). When non-empty, fan out only
   * to the listed channel ids — provided each is also enabled.
   *
   * Letting customers route specific insights to specific channels
   * (e.g. "critical revenue drops to PagerDuty; weekly signup nudges
   * to email") without forcing them to set up multiple "modes" of
   * routing config. Default-to-all preserves backward compat for
   * pre-edit-modal insights.
   */
  channelIds?: string[];

  /** Latest evaluated value. null when no successful evaluation yet. */
  currentValue: number | null;
  /** Prior evaluated value, used by change_pct_* rules. */
  previousValue: number | null;

  status: InsightStatus;
  /** When status last transitioned idle → fired. Cleared on fired → idle. */
  firedAt?: FirestoreTimestamp | null;

  /** When the most recent evaluation completed (success or failure). */
  lastEvaluatedAt?: FirestoreTimestamp | null;
  /**
   * Populated when the most recent evaluation errored (SQL syntax,
   * schema drift, non-numeric result, etc). Cleared on the next
   * successful evaluation. The displayed currentValue/status remain
   * whatever the last successful eval set them to — same staleness
   * model as filter-driven charts.
   */
  lastEvalError?: string | null;

  /** Prompt that opens this insight in chat for deeper exploration. */
  prefill: string;

  createdBy: string;
  createdAt: FirestoreTimestamp;
  updatedAt?: FirestoreTimestamp | null;
}

/**
 * Firestore timestamp shape as serialised to clients via Response.json.
 * The SDK's `Timestamp` becomes `{ _seconds, _nanoseconds }` over the
 * wire. Declared locally so the type lives next to the consumer.
 */
export interface FirestoreTimestamp {
  _seconds: number;
  _nanoseconds: number;
}
