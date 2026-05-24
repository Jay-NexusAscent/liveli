import { z } from "zod";
import { createInsight } from "@/lib/insights/create";
import {
  clampFrequency,
  FREQUENCY_VALUES,
  type InsightFrequency,
} from "@/lib/insights/frequency";
// DEFAULT_FREQUENCY no longer imported directly — clampFrequency
// applies it when input.frequency is undefined.
import type { InsightCategory, RuleType } from "@/lib/insights/types";
import type { ToolDefinition } from "./types";

/**
 * Input schema is intentionally FLAT — same Gemini Schema constraints
 * as make_dashboard. The discriminated union (rule per type with
 * different threshold semantics) is collapsed into a single
 * `ruleType` enum + a single `threshold` number; semantics differ by
 * ruleType (pct vs absolute) but the shape is uniform.
 *
 * IMPORTANT: keep this shape in sync with the per-proposal schema in
 * propose-insights.ts. When the user clicks Save on a proposal card,
 * the UI POSTs the proposal payload straight to /api/insights, which
 * runs the SAME createInsight() helper. If the two schemas drift,
 * agent-direct-save and user-accept-proposal silently diverge.
 */
const Input = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe("Short headline — what's being tracked, e.g. 'Weekly new signups'."),
  description: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "One-line explanation. Will be shown on the insight card. Don't put numbers here — they're computed from sourceSql."
    ),
  category: z
    .enum(["Sales", "Customer", "Operational", "Growth"])
    .describe("Card-colour category."),
  sourceSql: z
    .string()
    .min(1)
    .describe(
      "SELECT that returns EXACTLY one row with EXACTLY one numeric column. The first value of the first row is what gets tracked. Aggregate (COUNT/SUM/AVG/etc) to ensure one row."
    ),
  sourceConnector: z
    .string()
    .max(80)
    .optional()
    .describe("Optional connector/source label shown on the card, e.g. 'Postgres Demo'."),
  ruleType: z
    .enum(["change_pct_above", "change_pct_below", "value_above", "value_below"])
    .describe(
      "When this alert should fire. change_pct_above/below compare against the previous evaluation; value_above/below compare to an absolute threshold."
    ),
  threshold: z
    .number()
    .describe(
      "For change_pct_*: percent (5 = 5%). For value_*: absolute number in the unit of the tracked value."
    ),
  prefill: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "Prompt the user sees when clicking 'Open in chat' on the saved insight card. Should ask the agent to dig deeper into this metric."
    ),
  frequency: z
    .enum(FREQUENCY_VALUES as readonly [InsightFrequency, ...InsightFrequency[]])
    .optional()
    .describe(
      "How often the insight is evaluated. DEFAULT '24h' (daily) — match the rhythm of most business metrics. Use '5m'/'15m'/'30m' ONLY for ops-style signals where minutes matter. Use '1h'/'6h'/'12h' for intra-day business metrics the user explicitly asked for. Tighter cadence = more BigQuery cost; don't pick tighter than the signal requires."
    ),
  // channelIds: per-insight channel subscription. Omit unless the
  // user has explicitly asked to route this insight to specific
  // channels (and the agent has been told their ids). The default
  // — undefined — means fan out to all enabled channels, which is
  // what most customers expect.
});

export const saveInsightTool: ToolDefinition = {
  name: "save_insight",
  description:
    "Save a live-evaluated alert insight DIRECTLY (no preview step). The insight runs `sourceSql` once at save time to seed the baseline, and again on each re-evaluation (manual button or scheduled cron). Fires when the rule's condition is met. Use ONLY when the user has asked to TRACK / MONITOR / ALERT on a SPECIFIC metric they've already named (e.g. 'track my AOV weekly'). For 'suggest insights' or 'recommend insights' requests, use `propose_insights` instead so the user can pick.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const input = Input.parse(raw);
    const result = await createInsight(
      {
        title: input.title,
        description: input.description,
        category: input.category as InsightCategory,
        sourceSql: input.sourceSql,
        sourceConnector: input.sourceConnector,
        ruleType: input.ruleType as RuleType,
        threshold: input.threshold,
        prefill: input.prefill,
        // Tier-clamp before persistence — same as the POST endpoint.
        // The agent can pick any frequency; the gate downgrades
        // tighter-than-tier picks to the tier max rather than erroring.
        frequency: clampFrequency(
          input.frequency as InsightFrequency | undefined,
          undefined /* tier — wire from ctx.workspace once tier is on workspace doc */
        ),
      },
      ctx
    );

    return {
      content: {
        ok: true,
        ...result,
      },
      // No clientRender — the chat just gets prose confirmation and
      // the user navigates to /insights to see the saved alert.
      // Inline insight preview in chat is a follow-up — see PR body.
    };
  },
};
