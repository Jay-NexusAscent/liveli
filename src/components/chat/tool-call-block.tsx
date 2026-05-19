"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface ToolCallBlockProps {
  name: string;
  status: "running" | "done" | "error";
  input?: unknown;
  output?: unknown;
  error?: string;
  /**
   * Map of BigQuery dataset name → connector friendly name. Used to
   * substitute the technical `c_<id>__w_<id>__d_<id>` identifiers in
   * displayed SQL with the user-recognisable connector name like
   * "Postgres Demo". Built once per ChatWindow mount from /api/connectors.
   */
  datasetNames?: Record<string, string>;
}

/**
 * Collapsed tool-call indicator. Click to expand and inspect what the
 * agent did. Different tools get different expanded views:
 *
 *   - run_sql        → friendly SQL with dataset IDs replaced by source
 *                       names; row-count + scan-size summary
 *   - other tools    → raw JSON input/output (debug-style)
 *
 * Default-collapsed so the chat thread stays readable; expanding gives
 * power users the audit trail.
 */
export function ToolCallBlock({
  name,
  status,
  input,
  output,
  error,
  datasetNames,
}: ToolCallBlockProps) {
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
        <span>{label}</span>
        {error && <span className="ml-auto text-[color:var(--status-error)]">{error}</span>}
        {isInteractive && (
          <span className="ml-auto text-text-tertiary">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 text-[11px]">
          {name === "run_sql" ? (
            <RunSqlDetails input={input} output={output} datasetNames={datasetNames} />
          ) : (
            <GenericDetails input={input} output={output} />
          )}
        </div>
      )}
    </div>
  );
}

function RunSqlDetails({
  input,
  output,
  datasetNames,
}: {
  input?: unknown;
  output?: unknown;
  datasetNames?: Record<string, string>;
}) {
  const sql = extractSql(input);
  const summary = extractRunSqlSummary(output);

  return (
    <>
      {sql && (
        <div className="mb-2">
          <div className="mb-1 text-text-tertiary">SQL</div>
          <pre className="overflow-x-auto rounded bg-background/50 p-2 font-mono text-text-secondary">
            {humanizeSql(sql, datasetNames)}
          </pre>
        </div>
      )}
      {summary && (
        <div className="flex items-center gap-3 text-text-tertiary">
          <span>
            {summary.rowCount} {summary.rowCount === 1 ? "row" : "rows"}
          </span>
          {summary.bytesScanned !== undefined && (
            <span>· scanned {formatBytes(summary.bytesScanned)}</span>
          )}
          {summary.truncated && <span>· truncated</span>}
        </div>
      )}
    </>
  );
}

function GenericDetails({ input, output }: { input?: unknown; output?: unknown }) {
  return (
    <>
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
    </>
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
    list_tables: "Inspecting your data sources",
    run_sql: "Querying your data",
    make_chart: "Drawing a chart",
    make_dashboard: "Composing a dashboard",
  };
  const base = labels[name] ?? name;
  if (status === "running") return `${base}…`;
  if (status === "done") return base;
  if (status === "error") return `${base} (failed)`;
  return base;
}

function extractSql(input: unknown): string | undefined {
  if (input && typeof input === "object" && "sql" in input) {
    const sql = (input as { sql: unknown }).sql;
    if (typeof sql === "string") return sql;
  }
  return undefined;
}

interface RunSqlSummary {
  rowCount: number;
  bytesScanned?: number;
  truncated?: boolean;
}

function extractRunSqlSummary(output: unknown): RunSqlSummary | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.rowCount !== "number") return null;
  return {
    rowCount: o.rowCount,
    bytesScanned: typeof o.bytesScanned === "number" ? o.bytesScanned : undefined,
    truncated: o.truncated === true,
  };
}

/**
 * Substitute internal dataset IDs (c_xxx__w_xxx__d_xxx) with the
 * connector's user-supplied friendly name. Matches the dataset within
 * backtick-quoted qualified names and bare references.
 */
function humanizeSql(sql: string, datasetNames?: Record<string, string>): string {
  if (!datasetNames || Object.keys(datasetNames).length === 0) return sql;
  let out = sql;
  for (const [dataset, friendly] of Object.entries(datasetNames)) {
    const safe = dataset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\`${safe}\\.`, "g"), `\`${friendly}.`);
    out = out.replace(new RegExp(`\\b${safe}\\.`, "g"), `${friendly}.`);
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
