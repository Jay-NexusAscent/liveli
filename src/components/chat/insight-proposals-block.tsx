"use client";

import { useState } from "react";
import { CheckIcon, SparkleIcon, TrendDownIcon, TrendUpIcon } from "@/components/icons";
import type { InsightProposal } from "@/lib/streaming";

/**
 * Renders proposed insights as inline cards in the chat conversation,
 * each with a Save button that POSTs to /api/insights. Nothing is
 * persisted by the agent — saving happens when the user clicks.
 *
 * Per-card state lives in this component (saved / saving / error) and
 * is page-load-scoped. A chat reload renders fresh cards; previously-
 * saved proposals come back with the Save button active again. The
 * trade-off vs server-side "already saved" tracking is simpler code
 * for a small UX wart: clicking Save twice creates two identical
 * insights. Acceptable for v1 — the user can delete duplicates on the
 * insights page.
 *
 * Card colour categories match the `/insights` page exactly so the
 * preview-in-chat looks like the destination.
 */

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; insightId: string }
  | { status: "error"; message: string };

const CATEGORY_STYLES: Record<InsightProposal["category"], string> = {
  Sales: "bg-accent-muted text-accent",
  Customer: "bg-[#10B981]/15 text-[#10B981]",
  Operational: "bg-[#F59E0B]/15 text-[#F59E0B]",
  Growth: "bg-[#8B5CF6]/15 text-[#8B5CF6]",
};

/**
 * One-line description of when each rule type fires. Same wording as
 * the /insights page so the user sees consistent labelling between
 * the proposal preview and the saved card.
 */
function describeRule(rule: { type: InsightProposal["ruleType"]; threshold: number }): string {
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

export function InsightProposalsBlock({ proposals }: { proposals: InsightProposal[] }) {
  // Track save state per card by array index. Array index is stable
  // for this render — proposals are immutable once emitted by the
  // agent (they're props derived from the SSE event).
  const [saveStates, setSaveStates] = useState<Record<number, SaveState>>({});

  const setStateFor = (i: number, s: SaveState) =>
    setSaveStates((m) => ({ ...m, [i]: s }));

  const save = async (i: number, proposal: InsightProposal) => {
    setStateFor(i, { status: "saving" });
    try {
      const res = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposal),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStateFor(i, {
          status: "error",
          message: payload?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setStateFor(i, {
        status: "saved",
        insightId: payload.insightId ?? "",
      });
    } catch (err) {
      setStateFor(i, {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (proposals.length === 0) return null;

  return (
    <div className="my-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
        <SparkleIcon className="text-accent" />
        <span>{proposals.length} suggested insight{proposals.length === 1 ? "" : "s"} — pick which to save</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {proposals.map((p, i) => {
          const state = saveStates[i] ?? { status: "idle" };
          return (
            <ProposalCard
              key={i}
              proposal={p}
              state={state}
              onSave={() => save(i, p)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  state,
  onSave,
}: {
  proposal: InsightProposal;
  state: SaveState;
  onSave: () => void;
}) {
  const isPctRule =
    proposal.ruleType === "change_pct_above" || proposal.ruleType === "change_pct_below";
  const isUpward =
    proposal.ruleType === "change_pct_above" || proposal.ruleType === "value_above";

  return (
    <article className="card-elevated flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${CATEGORY_STYLES[proposal.category]}`}
        >
          {proposal.category}
        </span>
        {isPctRule && (
          <div className={`flex items-center gap-0.5 text-[12px] ${isUpward ? "text-[#10B981]" : "text-[#EF4444]"}`}>
            {isUpward ? <TrendUpIcon /> : <TrendDownIcon />}
            <span className="font-mono tabular-nums">{proposal.threshold}%</span>
          </div>
        )}
      </div>

      <h3 className="text-[14px] font-semibold leading-snug text-text-primary font-heading">
        {proposal.title}
      </h3>

      <p className="text-[12px] leading-relaxed text-text-secondary">
        {proposal.description}
      </p>

      <p className="text-[11px] text-text-tertiary">
        {describeRule({ type: proposal.ruleType, threshold: proposal.threshold })}
      </p>

      {state.status === "error" && (
        <div
          className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-2 py-1 text-[11px] text-[color:var(--status-error)]"
          role="status"
        >
          Couldn&apos;t save: {state.message}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="truncate text-[11px] text-text-tertiary">
          {proposal.sourceConnector ?? "Custom SQL"}
        </span>
        <SaveButton state={state} onSave={onSave} />
      </div>
    </article>
  );
}

function SaveButton({ state, onSave }: { state: SaveState; onSave: () => void }) {
  if (state.status === "saved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-[#10B981]/15 px-2.5 py-1 text-[11px] font-medium text-[#10B981]">
        <CheckIcon />
        Saved
      </span>
    );
  }
  if (state.status === "saving") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-elevated px-2.5 py-1 text-[11px] text-text-tertiary">
        Saving…
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onSave}
      className="inline-flex items-center gap-1 rounded-md bg-accent-muted px-2.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent hover:text-white"
    >
      {state.status === "error" ? "Retry" : "Save"}
    </button>
  );
}
