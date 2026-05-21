"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChartRenderer } from "./chart-renderer";

interface ChartBlockProps {
  title: string;
  spec: unknown;
  toolId: string;
  chatId?: string;
}

/**
 * Inline ECharts render with "Save to dashboard" affordance. The chart
 * spec is whatever the agent emitted via make_chart — validated against
 * the Zod schema server-side so it's safe to pass through.
 */
export function ChartBlock({ title, spec, toolId, chatId }: ChartBlockProps) {
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = async () => {
    setSaveState("saving");
    try {
      const res = await fetch("/api/charts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, spec, chatId }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  };

  return (
    <div className="card-elevated my-3 overflow-hidden" data-tool-id={toolId}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="text-[13px] font-medium text-text-primary">{title}</div>
        <button
          type="button"
          onClick={save}
          disabled={saveState !== "idle"}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
            saveState === "idle" && "bg-accent-muted text-accent hover:bg-accent-subtle",
            saveState === "saving" && "bg-accent-muted text-accent opacity-60",
            saveState === "saved" && "bg-success/15 text-[color:var(--status-success)]",
            saveState === "error" && "bg-error/15 text-[color:var(--status-error)]"
          )}
        >
          {saveState === "idle" && "Save to dashboard"}
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && "Saved ✓"}
          {saveState === "error" && "Failed — retry"}
        </button>
      </div>
      <div className="p-3">
        <ChartRenderer spec={spec} height={320} />
      </div>
    </div>
  );
}
