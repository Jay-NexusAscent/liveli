import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { insightsIn } from "@/lib/firestore";
import { safeQuery } from "@/lib/bigquery";
import { applyRule, extractScalarValue } from "@/lib/insights/evaluate";
import type {
  Insight,
  InsightCategory,
  InsightStatus,
  RuleType,
} from "@/lib/insights/types";
import type { ToolDefinition } from "./types";

/**
 * Input schema is intentionally FLAT — same Gemini Schema constraints
 * as make_dashboard. The discriminated union (rule per type with
 * different threshold semantics) is collapsed into a single
 * `ruleType` enum + a single `threshold` number; semantics differ by
 * ruleType (pct vs absolute) but the shape is uniform.
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
});

export const saveInsightTool: ToolDefinition = {
  name: "save_insight",
  description:
    "Save a live-evaluated alert insight. The insight runs `sourceSql` once at save time to seed the baseline, and again on each re-evaluation (manual button or scheduled cron). Fires when the rule's condition is met. Use this when the user asks to TRACK or MONITOR something, OR when they ask you to suggest insights from their data.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const input = Input.parse(raw);

    // Run the SQL once at save time. Two goals:
    //   1. Verify the query is valid + meets the 1-row-1-numeric-col
    //      contract before we persist anything — otherwise we'd have
    //      a permanently-broken insight that errors on every eval.
    //   2. Seed currentValue so value_* rules can fire immediately
    //      and the UI has something to display on the first render.
    const queryResult = await safeQuery(input.sourceSql, {
      maxRows: 2, // 2 so we can detect "should have been 1" cleanly
      context: {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      },
    });
    const currentValue = extractScalarValue(queryResult.rows);

    // First evaluation — no previousValue yet. value_* rules can fire
    // immediately; change_pct_* rules return idle (need a baseline).
    const initialStatus: InsightStatus = applyRule(
      { type: input.ruleType as RuleType, threshold: input.threshold },
      currentValue,
      null
    );

    const ref = insightsIn(ctx.clientId, ctx.workspaceId).doc();
    const docData: Omit<Insight, "id" | "createdAt" | "firedAt" | "lastEvaluatedAt"> & {
      createdAt: FirebaseFirestore.FieldValue;
      lastEvaluatedAt: FirebaseFirestore.FieldValue;
      firedAt: FirebaseFirestore.FieldValue | null;
    } = {
      title: input.title,
      description: input.description,
      category: input.category as InsightCategory,
      sourceSql: input.sourceSql,
      ...(input.sourceConnector ? { sourceConnector: input.sourceConnector } : {}),
      rule: { type: input.ruleType as RuleType, threshold: input.threshold },
      currentValue,
      previousValue: null,
      status: initialStatus,
      firedAt: initialStatus === "fired" ? FieldValue.serverTimestamp() : null,
      lastEvaluatedAt: FieldValue.serverTimestamp(),
      lastEvalError: null,
      prefill: input.prefill,
      createdBy: ctx.userId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: null,
    };
    await ref.set(docData);

    return {
      content: {
        ok: true,
        insightId: ref.id,
        title: input.title,
        currentValue,
        status: initialStatus,
        firedImmediately: initialStatus === "fired",
      },
      // No clientRender — the chat just gets prose confirmation and
      // the user navigates to /insights to see the saved alert.
      // Inline insight preview in chat is a follow-up — see PR body.
    };
  },
};
