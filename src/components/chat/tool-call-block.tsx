"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface ToolCallBlockProps {
  name: string;
  status: "running" | "done" | "error";
  input?: unknown;
  output?: unknown;
  error?: string;
}

/**
 * Collapsed tool-call indicator. Click to expand and inspect the
 * input/output JSON. Useful for debugging and transparency about
 * what the agent actually did.
 */
export function ToolCallBlock({ name, status, input, output, error }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const label = friendlyToolLabel(name, status);
  const isInteractive = input !== undefined || output !== undefined || error !== undefined;

  return (
    <div className="my-2 rounded-md border border-border bg-elevated/50">
      <button
        type="button"
        onClick={() => isInteractive && setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary",
          isInteractive && "cursor-pointer hover:bg-hover"
        )}
      >
        <StatusDot status={status} />
        <span className="font-mono">{label}</span>
        {error && <span className="ml-auto text-[color:var(--status-error)]">{error}</span>}
        {isInteractive && (
          <span className="ml-auto text-text-tertiary">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 text-[11px]">
          {input !== undefined && input !== null && (
            <details open className="mb-2">
              <summary className="cursor-pointer text-text-tertiary">input</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-background/50 p-2 text-text-secondary">
                {JSON.stringify(input, null, 2)}
              </pre>
            </details>
          )}
          {output !== undefined && output !== null && (
            <details className="mb-1">
              <summary className="cursor-pointer text-text-tertiary">output</summary>
              <pre className="mt-1 max-h-[300px] overflow-auto rounded bg-background/50 p-2 text-text-secondary">
                {JSON.stringify(output, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: ToolCallBlockProps["status"] }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        status === "running" && "bg-accent animate-pulse",
        status === "done" && "bg-[color:var(--status-success)]",
        status === "error" && "bg-[color:var(--status-error)]"
      )}
    />
  );
}

function friendlyToolLabel(name: string, status: ToolCallBlockProps["status"]): string {
  const labels: Record<string, string> = {
    list_tables: "list_tables — discovering schema",
    run_sql: "run_sql — querying warehouse",
    make_chart: "make_chart — rendering chart",
    make_dashboard: "make_dashboard — composing dashboard",
  };
  const base = labels[name] ?? name;
  if (status === "running") return base;
  if (status === "done") return base.replace("…", "") + " · done";
  if (status === "error") return base + " · error";
  return base;
}
