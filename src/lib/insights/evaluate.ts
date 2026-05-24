import { FieldValue } from "@google-cloud/firestore";
import { insightsIn } from "@/lib/firestore";
import { safeQuery } from "@/lib/bigquery";
import type {
  Insight,
  InsightRule,
  InsightStatus,
  RuleType,
} from "./types";

/**
 * Pull a single numeric value out of a query result. Insight sourceSql
 * must return exactly one row with exactly one numeric column — this
 * helper enforces that contract and throws with a message the agent /
 * UI can show.
 *
 * Pure function — no I/O. Lets us unit-test the rule logic without
 * spinning up BigQuery.
 */
export function extractScalarValue(rows: Record<string, unknown>[]): number {
  if (rows.length === 0) {
    throw new Error("Query returned no rows. Insight SQL must return exactly one row.");
  }
  if (rows.length > 1) {
    throw new Error(
      `Query returned ${rows.length} rows. Insight SQL must return exactly one row (aggregate with COUNT/SUM/AVG etc).`
    );
  }
  const values = Object.values(rows[0]);
  if (values.length === 0) {
    throw new Error("Query returned a row with no columns.");
  }
  if (values.length > 1) {
    throw new Error(
      `Query returned ${values.length} columns. Insight SQL must return exactly one numeric column.`
    );
  }
  const raw = values[0];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  // BigQuery sometimes returns numerics as strings (especially for
  // NUMERIC / BIGNUMERIC types). Coerce when the string parses cleanly.
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(
    `Query returned a non-numeric value (${typeof raw}: ${JSON.stringify(raw)}). Insight SQL must return a number.`
  );
}

/**
 * Apply a rule to a new value and decide the resulting status.
 *
 * change_pct_* rules need a previousValue baseline — when one isn't
 * available (first evaluation, or last eval errored without saving)
 * they always return `idle`. This means the first eval after a save
 * for a change_pct rule never fires; the second is the earliest it
 * can fire. That's intentional — a single data point isn't enough to
 * say "this changed".
 *
 * value_* rules apply on every evaluation since they don't need a
 * baseline.
 *
 * Returns the rule's evaluation result. The caller decides whether
 * a transition idle → fired should stamp `firedAt`.
 */
export function applyRule(
  rule: InsightRule,
  newValue: number,
  previousValue: number | null
): InsightStatus {
  switch (rule.type) {
    case "change_pct_above": {
      if (previousValue == null || previousValue === 0) return "idle";
      const pct = ((newValue - previousValue) / Math.abs(previousValue)) * 100;
      return pct > rule.threshold ? "fired" : "idle";
    }
    case "change_pct_below": {
      if (previousValue == null || previousValue === 0) return "idle";
      const pct = ((previousValue - newValue) / Math.abs(previousValue)) * 100;
      return pct > rule.threshold ? "fired" : "idle";
    }
    case "value_above":
      return newValue > rule.threshold ? "fired" : "idle";
    case "value_below":
      return newValue < rule.threshold ? "fired" : "idle";
  }
}

/**
 * Human-readable description of what a rule will fire on. Used by the
 * UI "Tracking" section to tell users what each insight is watching
 * for. Kept here so future rule types add description in one place.
 */
export function describeRule(rule: InsightRule): string {
  switch (rule.type) {
    case "change_pct_above":
      return `Fires when value rises by more than ${rule.threshold}%`;
    case "change_pct_below":
      return `Fires when value drops by more than ${rule.threshold}%`;
    case "value_above":
      return `Fires when value exceeds ${rule.threshold}`;
    case "value_below":
      return `Fires when value falls below ${rule.threshold}`;
  }
}

/**
 * Run one full evaluation cycle for an insight:
 *   1. Load the doc
 *   2. Re-run sourceSql via safeQuery
 *   3. Apply the rule
 *   4. Write back: previousValue := old currentValue, currentValue :=
 *      new value, status, lastEvaluatedAt, optional firedAt.
 *
 * On SQL failure, writes `lastEvalError` and `lastEvaluatedAt` but
 * leaves `currentValue`, `previousValue`, and `status` untouched — the
 * UI surfaces the previous state with an error indicator (same
 * staleness model as filter-driven charts).
 *
 * Returns the resulting state so the caller (manual re-evaluate
 * endpoint, bulk cron handler) can respond with the updated doc
 * without an extra read.
 */
export async function evaluateInsight(
  insightId: string,
  ctx: { clientId: string; workspaceId: string; userId?: string }
): Promise<{
  ok: boolean;
  insight?: Insight & { id: string };
  error?: string;
}> {
  const ref = insightsIn(ctx.clientId, ctx.workspaceId).doc(insightId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, error: "Insight not found" };
  }
  const data = snap.data() as Insight;

  let newValue: number;
  try {
    const result = await safeQuery(data.sourceSql, {
      maxRows: 2, // Allow a 2nd row so we can detect "should have been 1" with a clean error
      context: {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      },
    });
    newValue = extractScalarValue(result.rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ref.update({
      lastEvaluatedAt: FieldValue.serverTimestamp(),
      lastEvalError: message,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: false, error: message };
  }

  const previousValue = data.currentValue;
  const nextStatus = applyRule(data.rule, newValue, previousValue);
  // Stamp firedAt only on transitions idle → fired. A re-fire (still
  // fired across two consecutive evaluations) keeps the original
  // firedAt so the UI shows when the alert STARTED, not the last
  // time it was re-checked.
  const wasIdle = data.status === "idle";
  const justFired = wasIdle && nextStatus === "fired";

  const updates: Record<string, unknown> = {
    previousValue,
    currentValue: newValue,
    status: nextStatus,
    lastEvaluatedAt: FieldValue.serverTimestamp(),
    lastEvalError: null,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (justFired) {
    updates.firedAt = FieldValue.serverTimestamp();
  } else if (nextStatus === "idle") {
    // Clear firedAt when the alert recovers.
    updates.firedAt = null;
  }
  await ref.update(updates);

  const fresh = (await ref.get()).data() as Insight;
  return { ok: true, insight: { ...fresh, id: insightId } };
}

/**
 * Bulk evaluate every insight in a workspace. Used by the cron-
 * targeted /api/insights/evaluate-all endpoint. Each insight evaluates
 * independently — one failure doesn't block the rest. Returns a
 * summary per id so the caller (or logs) can see what happened.
 *
 * The actual cron binding (Cloud Scheduler entry) is a follow-up
 * Linear ticket — until it lands, this endpoint is reachable only by
 * authenticated workspace users for ad-hoc bulk re-evaluation.
 */
export async function evaluateAllInsights(ctx: {
  clientId: string;
  workspaceId: string;
  userId?: string;
}): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  fired: number;
  results: Array<{ id: string; ok: boolean; status?: InsightStatus; error?: string }>;
}> {
  const snap = await insightsIn(ctx.clientId, ctx.workspaceId).get();
  const results: Array<{ id: string; ok: boolean; status?: InsightStatus; error?: string }> = [];
  let succeeded = 0;
  let failed = 0;
  let fired = 0;
  // Sequential to keep BigQuery + Firestore load predictable. With a
  // per-workspace cap (LIVELI follow-up ticket) of, say, 25 insights,
  // sequential evaluation finishes in seconds. Parallelising risks
  // hitting BQ slot quotas under fan-out.
  for (const doc of snap.docs) {
    const res = await evaluateInsight(doc.id, ctx);
    if (res.ok && res.insight) {
      succeeded += 1;
      if (res.insight.status === "fired") fired += 1;
      results.push({ id: doc.id, ok: true, status: res.insight.status });
    } else {
      failed += 1;
      results.push({ id: doc.id, ok: false, error: res.error });
    }
  }
  return {
    total: snap.size,
    succeeded,
    failed,
    fired,
    results,
  };
}

/** Re-exported for downstream type-only consumers. */
export type { RuleType };
