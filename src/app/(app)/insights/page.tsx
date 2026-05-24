"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  InsightIcon,
  SparkleIcon,
  TrashIcon,
  TrendDownIcon,
  TrendUpIcon,
} from "@/components/icons";
import type {
  FirestoreTimestamp,
  Insight,
  InsightCategory,
  InsightRule,
  RuleType,
} from "@/lib/insights/types";
import {
  DEFAULT_FREQUENCY,
  FREQUENCY_LABELS,
  FREQUENCY_VALUES,
  type InsightFrequency,
} from "@/lib/insights/frequency";

const PREFILL_STORAGE_KEY = "liveli.chatPrefill";

/**
 * Default suggest prefill — kicks the agent into propose-insights
 * mode. The agent inspects the schema, picks 3-5 candidate metrics,
 * and emits them as inline proposal cards via the propose_insights
 * tool. User clicks Save on the ones they want. No insights land in
 * Firestore until a Save click.
 *
 * Kept SHORT on purpose — the long-form prompt previously here
 * (with "write a SELECT that returns exactly one row…") leaked
 * implementation detail to the chat surface and made the suggest
 * button visibly verbose. The system prompt handles the contract.
 */
const SUGGEST_PREFILL = "Suggest 3-5 alert insights worth tracking from my data.";

/**
 * Server-side Insight shape with the local id added. Spread from the
 * /api/insights response. Matches Insight from @/lib/insights/types
 * with the id surfaced as a top-level field (Firestore docs don't
 * include their own id; we attach it server-side in GET /api/insights).
 */
type ApiInsight = Insight & { id: string };

const CATEGORY_STYLES: Record<InsightCategory, string> = {
  Sales: "bg-accent-muted text-accent",
  Customer: "bg-[#10B981]/15 text-[#10B981]",
  Operational: "bg-[#F59E0B]/15 text-[#F59E0B]",
  Growth: "bg-[#8B5CF6]/15 text-[#8B5CF6]",
};

/**
 * Human-readable rule label. Kept here (not imported from
 * lib/insights/evaluate) because that module pulls in Firestore +
 * BigQuery clients which we don't want bundled into the client
 * component.
 */
function describeRuleClient(rule: InsightRule): string {
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
 * Compute change percent between current and previous values. Returns
 * null when no comparison is meaningful (no previous value, or
 * previous value is zero — division-by-zero). Sign indicates direction.
 */
function changePct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Format a tracked value for display. Insights don't carry unit hints
 * in v1 — we just render the number with sensible precision. Large
 * numbers get thousands separators; small numbers get up to 2 decimals.
 * Bigger formatting (currency / percent) can come when the agent
 * starts emitting a unit hint per insight.
 */
function formatValue(v: number | null): string {
  if (v == null) return "—";
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Lightweight "n ago" formatter for Firestore timestamps. Exact
 * minute/hour/day buckets — anything fancier (Intl.RelativeTimeFormat
 * with smart pluralisation) is overkill for these cards.
 */
function timeAgo(ts: FirestoreTimestamp | null | undefined): string {
  if (!ts) return "never";
  const seconds = Math.floor(Date.now() / 1000 - ts._seconds);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function InsightsPage() {
  const router = useRouter();
  const [insights, setInsights] = useState<ApiInsight[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-id pending state for re-evaluate / delete — prevents
  // double-clicks and lets the action button dim while in-flight.
  const [evaluating, setEvaluating] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  // Bulk-evaluate state. Single boolean — only one bulk run at a time.
  const [evaluatingAll, setEvaluatingAll] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/insights");
        if (res.ok) {
          const items: ApiInsight[] = (await res.json()).items ?? [];
          setInsights(items);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /**
   * Stash a prompt and navigate to /chat. Same mechanism the old
   * mock-data version used — ChatWindow reads liveli.chatPrefill on
   * mount and pre-fills the input.
   */
  const openInChat = (prefill: string) => {
    sessionStorage.setItem(PREFILL_STORAGE_KEY, prefill);
    router.push("/chat");
  };

  /**
   * Re-evaluate one insight via /api/insights/<id>/evaluate. Updates
   * the card in place from the response — no full refetch needed.
   */
  const reevaluate = async (id: string) => {
    setEvaluating((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/insights/${id}/evaluate`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      if (payload.insight) {
        setInsights((items) =>
          items.map((i) => (i.id === id ? payload.insight : i))
        );
      } else if (payload.error) {
        // Eval ran but failed (SQL error etc) — fetch fresh row so
        // the lastEvalError field shows on the card.
        const fresh = await fetch("/api/insights");
        if (fresh.ok) {
          const items: ApiInsight[] = (await fresh.json()).items ?? [];
          setInsights(items);
        }
      }
    } catch (err) {
      alert(`Couldn't re-evaluate: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setEvaluating((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  /**
   * Re-evaluate ALL insights in the workspace. Fires one bulk request
   * to /api/insights/evaluate-all, then refetches the full list so
   * every card reflects the new state. Heavier than per-card but
   * easier to reason about than threading per-id updates through the
   * bulk-response shape.
   */
  const reevaluateAll = async () => {
    if (insights.length === 0) return;
    setEvaluatingAll(true);
    try {
      const res = await fetch("/api/insights/evaluate-all", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fresh = await fetch("/api/insights");
      if (fresh.ok) {
        const items: ApiInsight[] = (await fresh.json()).items ?? [];
        setInsights(items);
      }
    } catch (err) {
      alert(`Couldn't re-evaluate all: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setEvaluatingAll(false);
    }
  };

  /**
   * Change the evaluation frequency on one insight. PATCH-driven —
   * the server clamps the value to the workspace tier (today a
   * passthrough). Optimistically update local state; rollback on
   * failure so the picker doesn't appear to have saved when it
   * didn't.
   */
  const changeFrequency = async (id: string, next: InsightFrequency) => {
    let previous: ApiInsight[] = [];
    setInsights((items) => {
      previous = items;
      return items.map((i) => (i.id === id ? { ...i, frequency: next } : i));
    });
    try {
      const res = await fetch(`/api/insights/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frequency: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      // If the server clamped to a different value (tier gate), echo
      // it back into local state so the picker reflects what was
      // actually saved.
      if (payload.frequency && payload.frequency !== next) {
        setInsights((items) =>
          items.map((i) =>
            i.id === id ? { ...i, frequency: payload.frequency } : i
          )
        );
      }
    } catch (err) {
      setInsights(previous);
      alert(
        `Couldn't change frequency: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const deleteInsight = async (id: string, title: string) => {
    if (!confirm(`Delete insight "${title}"? This can't be undone.`)) return;
    setDeleting((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/insights/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInsights((items) => items.filter((i) => i.id !== id));
    } catch (err) {
      alert(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  // Split into fired + idle. Fired-first ordering puts active alerts
  // at the top where the user is most likely to look. Within each
  // bucket, preserve the server's createdAt-desc order.
  const fired = insights.filter((i) => i.status === "fired");
  const tracking = insights.filter((i) => i.status === "idle");
  const isEmpty = !loading && insights.length === 0;

  return (
    <div className="container-page py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">
            Insights
          </h1>
          <p className="mt-1 text-[14px] text-text-secondary">
            Live-evaluated alerts the agent is watching for you. Click&nbsp;
            <span className="text-text-primary">Open in chat</span> on any
            insight to dig deeper, or ask the agent to suggest more.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {insights.length > 0 && (
            <button
              type="button"
              onClick={reevaluateAll}
              disabled={evaluatingAll}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {evaluatingAll ? "Re-evaluating…" : "Re-evaluate all"}
            </button>
          )}
          <button
            type="button"
            onClick={() => openInChat(SUGGEST_PREFILL)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-text-inverted transition-colors hover:bg-accent-hover"
          >
            <SparkleIcon />
            Suggest insights
          </button>
        </div>
      </header>

      {loading && <p className="text-[13px] text-text-tertiary">Loading…</p>}

      {isEmpty && (
        <div className="card-elevated flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-muted text-accent">
            <InsightIcon className="text-accent" />
          </div>
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary font-heading">
            No insights yet
          </h2>
          <p className="max-w-md text-[14px] text-text-secondary">
            Insights are live-evaluated alerts. Ask the agent to suggest some
            from your data — it&apos;ll write the SQL and pick thresholds.
          </p>
          <button
            type="button"
            onClick={() => openInChat(SUGGEST_PREFILL)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-text-inverted transition-colors hover:bg-accent-hover"
          >
            <SparkleIcon />
            Ask the agent to suggest insights
          </button>
        </div>
      )}

      {fired.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wider text-[color:var(--status-error)]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--status-error)]" />
            Active alerts ({fired.length})
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {fired.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                isFired
                isEvaluating={evaluating.has(insight.id)}
                isDeleting={deleting.has(insight.id)}
                onReevaluate={() => reevaluate(insight.id)}
                onOpenInChat={() => openInChat(insight.prefill)}
                onDelete={() => deleteInsight(insight.id, insight.title)}
                onChangeFrequency={(f) => changeFrequency(insight.id, f)}
              />
            ))}
          </div>
        </section>
      )}

      {tracking.length > 0 && (
        <section>
          <h2 className="mb-4 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
            Tracking ({tracking.length})
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {tracking.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                isFired={false}
                isEvaluating={evaluating.has(insight.id)}
                isDeleting={deleting.has(insight.id)}
                onReevaluate={() => reevaluate(insight.id)}
                onOpenInChat={() => openInChat(insight.prefill)}
                onDelete={() => deleteInsight(insight.id, insight.title)}
                onChangeFrequency={(f) => changeFrequency(insight.id, f)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * One insight card. Variant differences for fired vs idle live here —
 * the alert badge, the change-delta callout, the slightly redder
 * frame on fired. Keeping it one component avoids two near-identical
 * card definitions drifting apart.
 */
function InsightCard({
  insight,
  isFired,
  isEvaluating,
  isDeleting,
  onReevaluate,
  onOpenInChat,
  onDelete,
  onChangeFrequency,
}: {
  insight: ApiInsight;
  isFired: boolean;
  isEvaluating: boolean;
  isDeleting: boolean;
  onReevaluate: () => void;
  onOpenInChat: () => void;
  onDelete: () => void;
  onChangeFrequency: (next: InsightFrequency) => void;
}) {
  const pct = changePct(insight.currentValue, insight.previousValue);
  const ruleTypeIsChange =
    insight.rule.type === "change_pct_above" ||
    insight.rule.type === "change_pct_below";

  return (
    <article
      className={`card-elevated flex flex-col gap-4 p-5 ${
        isFired ? "border-[color:var(--status-error)]/40" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${CATEGORY_STYLES[insight.category]}`}
        >
          {insight.category}
        </span>
        <div className="flex items-center gap-2">
          {isFired && (
            <span className="rounded-full bg-[color:var(--status-error)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--status-error)]">
              Fired {timeAgo(insight.firedAt)}
            </span>
          )}
          <span className="text-[12px] text-text-tertiary" title={`Last evaluated ${timeAgo(insight.lastEvaluatedAt)}`}>
            {timeAgo(insight.lastEvaluatedAt)}
          </span>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[16px] font-semibold leading-snug tracking-tight text-text-primary font-heading">
          {insight.title}
        </h2>
        <ValueBadge
          current={insight.currentValue}
          previous={insight.previousValue}
          pct={pct}
          ruleType={insight.rule.type}
        />
      </div>

      <p className="text-[13px] leading-relaxed text-text-secondary">
        {insight.description}
      </p>

      <p className="text-[12px] text-text-tertiary">
        {describeRuleClient(insight.rule)}
        {ruleTypeIsChange && insight.previousValue == null && (
          <span className="ml-1 italic">
            (needs another evaluation to compare against)
          </span>
        )}
      </p>

      {insight.lastEvalError && (
        <div
          className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-2.5 py-1.5 text-[12px] text-[color:var(--status-error)]"
          role="status"
        >
          Last evaluation failed.{" "}
          <span className="text-text-tertiary" title={insight.lastEvalError}>
            (details)
          </span>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-tertiary">
          <InsightIcon className="opacity-60" />
          <span className="truncate">{insight.sourceConnector ?? "Custom SQL"}</span>
        </span>
        <FrequencyPicker
          current={insight.frequency ?? DEFAULT_FREQUENCY}
          onChange={onChangeFrequency}
          title={insight.title}
        />
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onReevaluate}
            disabled={isEvaluating}
            className="rounded-md px-2 py-1 text-[12px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isEvaluating ? "…" : "Re-evaluate"}
          </button>
          <button
            type="button"
            onClick={onOpenInChat}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-muted px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-text-inverted"
          >
            Open in chat
            <ArrowRightIcon className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            aria-label={`Delete insight ${insight.title}`}
            className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * Native <select> dropdown for evaluation frequency. Same reasoning
 * as the FilterBar's date_range / granularity / select controls —
 * native gives platform-correct keyboard handling and no a11y rework.
 * Renders the seven FREQUENCY_VALUES as options; current selection is
 * driven by the parent. Change → onChange, which the parent PATCHes
 * to the server.
 *
 * When tier gating ships (LIVELI-125), this component should grey out
 * options above the workspace's tier max and add a small "Paid plan"
 * affordance next to them. For now all options are selectable.
 */
function FrequencyPicker({
  current,
  onChange,
  title,
}: {
  current: InsightFrequency;
  onChange: (next: InsightFrequency) => void;
  title: string;
}) {
  return (
    <select
      aria-label={`Evaluation frequency for ${title}`}
      value={current}
      onChange={(e) => onChange(e.target.value as InsightFrequency)}
      className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-text-secondary transition-colors hover:border-accent focus:border-accent focus:outline-none"
    >
      {FREQUENCY_VALUES.map((f) => (
        <option key={f} value={f}>
          {FREQUENCY_LABELS[f]}
        </option>
      ))}
    </select>
  );
}

/**
 * The headline value + delta to the previous evaluation. For change_pct
 * rules we lead with the percent (the rule-relevant number); for
 * value rules we lead with the raw value. The previous value is shown
 * underneath when available so users can sanity-check the comparison.
 */
function ValueBadge({
  current,
  previous,
  pct,
  ruleType,
}: {
  current: number | null;
  previous: number | null;
  pct: number | null;
  ruleType: RuleType;
}) {
  const ruleTypeIsChange = ruleType === "change_pct_above" || ruleType === "change_pct_below";

  if (current == null) {
    return <span className="text-[13px] text-text-tertiary">—</span>;
  }

  if (ruleTypeIsChange) {
    // Lead with percent change. Previous + current shown as context.
    if (pct == null) {
      return (
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span className="font-mono text-[14px] tabular-nums text-text-primary">
            {formatValue(current)}
          </span>
          <span className="text-[11px] text-text-tertiary">no baseline yet</span>
        </div>
      );
    }
    const isUp = pct > 0;
    const isDown = pct < 0;
    const color = isUp
      ? "text-[#10B981]"
      : isDown
        ? "text-[#EF4444]"
        : "text-text-tertiary";
    return (
      <div className="flex flex-col items-end gap-0.5 text-right">
        <div className={`flex items-center gap-1 font-mono text-[14px] tabular-nums ${color}`}>
          {isUp && <TrendUpIcon />}
          {isDown && <TrendDownIcon />}
          <span>
            {pct > 0 ? "+" : ""}
            {pct.toFixed(1)}%
          </span>
        </div>
        <span className="text-[11px] text-text-tertiary tabular-nums">
          {formatValue(previous)} → {formatValue(current)}
        </span>
      </div>
    );
  }

  // value_above / value_below — lead with raw value.
  return (
    <span className="font-mono text-[15px] tabular-nums text-text-primary">
      {formatValue(current)}
    </span>
  );
}

