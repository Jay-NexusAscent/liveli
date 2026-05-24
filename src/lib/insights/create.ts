import { FieldValue } from "@google-cloud/firestore";
import { insightsIn } from "@/lib/firestore";
import { safeQuery } from "@/lib/bigquery";
import { applyRule, extractScalarValue } from "./evaluate";
import { DEFAULT_FREQUENCY, type InsightFrequency } from "./frequency";
import type {
  Insight,
  InsightCategory,
  InsightStatus,
  RuleType,
} from "./types";

/**
 * Validated, post-parse shape that both callers share. Keeping this
 * as a plain interface (not z.infer) means the file doesn't import
 * zod — each caller validates with its own schema and hands a clean
 * object to this helper.
 *
 * Why this exists: the `save_insight` tool handler and the
 * `POST /api/insights` route both need the same save sequence — run
 * SQL once, validate it returns a scalar, apply the rule, write the
 * doc. Without this helper, the two callers would drift apart over
 * time (one gets a new field, the other forgets) and the
 * agent-saved vs UI-saved code paths would silently disagree.
 */
export interface CreateInsightInput {
  title: string;
  description: string;
  category: InsightCategory;
  sourceSql: string;
  sourceConnector?: string;
  ruleType: RuleType;
  threshold: number;
  prefill: string;
  /**
   * Evaluation frequency. Defaults to DEFAULT_FREQUENCY (24h) when
   * the caller omits it. Tier gating happens in the API route layer
   * (the agent doesn't know which tier the workspace is on) — by
   * the time inputs reach createInsight, this value has been
   * clamped to the workspace's allowed range.
   */
  frequency?: InsightFrequency;
  /**
   * Per-insight channel subscription. Undefined / empty = fan out to
   * every enabled channel in the workspace; non-empty = fan out only
   * to the listed channel ids. See Insight.channelIds for the full
   * routing rationale.
   */
  channelIds?: string[];
}

export interface CreateInsightResult {
  insightId: string;
  title: string;
  currentValue: number;
  status: InsightStatus;
  firedImmediately: boolean;
  frequency: InsightFrequency;
}

/**
 * Create an insight: run SQL once at save time to seed currentValue,
 * apply the rule (value_* rules can fire immediately; change_pct_*
 * rules start idle because there's no baseline yet), persist to
 * Firestore.
 *
 * Throws on:
 *   - SQL execution failure (BigQuery error, scan-cap, etc.)
 *   - Result not matching the 1-row × 1-numeric-column contract
 *     (extractScalarValue throws with a helpful message)
 * Callers (tool handler, API route) surface those messages to their
 * respective audiences (agent or HTTP client).
 */
export async function createInsight(
  input: CreateInsightInput,
  ctx: { clientId: string; workspaceId: string; userId: string }
): Promise<CreateInsightResult> {
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
    { type: input.ruleType, threshold: input.threshold },
    currentValue,
    null
  );

  const ref = insightsIn(ctx.clientId, ctx.workspaceId).doc();
  const frequency: InsightFrequency = input.frequency ?? DEFAULT_FREQUENCY;
  const docData: Omit<Insight, "id" | "createdAt" | "firedAt" | "lastEvaluatedAt"> & {
    createdAt: FirebaseFirestore.FieldValue;
    lastEvaluatedAt: FirebaseFirestore.FieldValue;
    firedAt: FirebaseFirestore.FieldValue | null;
  } = {
    title: input.title,
    description: input.description,
    category: input.category,
    sourceSql: input.sourceSql,
    ...(input.sourceConnector ? { sourceConnector: input.sourceConnector } : {}),
    rule: { type: input.ruleType, threshold: input.threshold },
    frequency,
    // Only persist channelIds when non-empty. Empty / undefined =
    // "fan out to all enabled channels" — keeping the field absent
    // for that case avoids ambiguity (is [] "no channels" or "all
    // channels"?). The notify dispatcher checks length.
    ...(input.channelIds && input.channelIds.length > 0
      ? { channelIds: input.channelIds }
      : {}),
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
    insightId: ref.id,
    title: input.title,
    currentValue,
    status: initialStatus,
    firedImmediately: initialStatus === "fired",
    frequency,
  };
}
