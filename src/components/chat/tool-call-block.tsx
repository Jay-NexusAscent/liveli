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
 * Collapsed tool-call indicator. Click to expand and see a friendly
 * customer-facing summary of what the tool did. Each tool gets a
 * curated expanded view — never a raw JSON dump for customer-visible
 * fields (internal dataset IDs, model-generated schemas, etc.).
 *
 * Per-tool views:
 *   - run_sql        → SQL with dataset IDs replaced; row + scan summary
 *   - list_tables    → tables grouped by connector friendly name
 *   - make_chart     → chart title, type, series count
 *   - make_dashboard → dashboard title + chart titles
 *   - other (unknown) → JSON fallback (debug; shouldn't be reached in
 *                       customer use)
 *
 * Default-collapsed so the chat stays readable. Tools with no usable
 * detail (no input, no output, no error) render as a non-interactive
 * pill — no expand affordance to invite a confusing empty drawer.
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
  const hasDetails = toolHasDetails(name, input, output, error);

  return (
    <div className="my-2 rounded-md border border-border bg-elevated/50">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary",
          hasDetails && "cursor-pointer hover:bg-hover"
        )}
      >
        <StatusDot status={status} />
        <span>{label}</span>
        {error && <span className="ml-auto text-[color:var(--status-error)]">{error}</span>}
        {hasDetails && (
          <span className="ml-auto text-text-tertiary">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 text-[11px]">
          {name === "run_sql" ? (
            <RunSqlDetails input={input} output={output} datasetNames={datasetNames} />
          ) : name === "list_tables" ? (
            <ListTablesDetails output={output} />
          ) : name === "make_chart" ? (
            <MakeChartDetails input={input} />
          ) : name === "make_dashboard" ? (
            <MakeDashboardDetails input={input} />
          ) : (
            <GenericDetails input={input} output={output} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * True if there's anything useful to show under the tool block when
 * expanded. Used to suppress the expand chevron on tools whose
 * input/output is empty or pointless to display (e.g. list_tables with
 * no args and still-running output).
 */
function toolHasDetails(
  name: string,
  input?: unknown,
  output?: unknown,
  error?: string
): boolean {
  if (error) return true;
  if (name === "list_tables") {
    return !!output && typeof output === "object";
  }
  if (name === "run_sql") {
    return !!input || !!output;
  }
  if (name === "make_chart" || name === "make_dashboard") {
    return !!input;
  }
  // Unknown tool — fall through to JSON view only if there's something
  // non-trivial.
  return !isEmptyValue(input) || !isEmptyValue(output);
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v as Record<string, unknown>).length === 0;
  }
  return false;
}

// ── Per-tool detail views ─────────────────────────────────────────

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

interface ListTablesTable {
  table: string;
  rowCount?: number;
  connectorName?: string;
  connectorType?: string;
  columns?: Array<{ name: string; type: string }>;
}

function ListTablesDetails({ output }: { output?: unknown }) {
  if (!output || typeof output !== "object") return null;
  const tables = (output as { tables?: ListTablesTable[] }).tables;
  if (!Array.isArray(tables) || tables.length === 0) {
    return (
      <div className="text-text-tertiary">
        No tables found yet. Connect a data source on the Connections tab to get started.
      </div>
    );
  }

  // Group by connector friendly name — falls back to connectorType
  // (e.g. "postgres") if the user hasn't named the connector, and to
  // "Source" as last resort. Never show the internal dataset id.
  const grouped = new Map<string, ListTablesTable[]>();
  for (const t of tables) {
    const conn = t.connectorName || prettifyConnectorType(t.connectorType) || "Source";
    if (!grouped.has(conn)) grouped.set(conn, []);
    grouped.get(conn)!.push(t);
  }

  return (
    <div className="space-y-2">
      {Array.from(grouped.entries()).map(([conn, conns]) => (
        <div key={conn}>
          <div className="mb-1 text-text-secondary">{conn}</div>
          <ul className="space-y-0.5 pl-3">
            {conns.map((t) => (
              <li key={t.table} className="flex items-baseline gap-2">
                <span className="font-mono text-text-primary">{t.table}</span>
                <span className="text-text-tertiary">
                  {t.rowCount !== undefined &&
                    `${t.rowCount.toLocaleString()} ${t.rowCount === 1 ? "row" : "rows"}`}
                  {t.columns && t.columns.length > 0 && (
                    <>
                      {t.rowCount !== undefined && " · "}
                      {t.columns.length}{" "}
                      {t.columns.length === 1 ? "column" : "columns"}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function MakeChartDetails({ input }: { input?: unknown }) {
  if (!input || typeof input !== "object") return null;
  const i = input as {
    title?: string;
    echartsOption?: { series?: Array<{ type?: string }> };
  };
  const title = i.title;
  const seriesArr = i.echartsOption?.series ?? [];
  const types = Array.from(
    new Set(seriesArr.map((s) => s.type).filter((t): t is string => !!t))
  );

  return (
    <div className="space-y-1 text-text-secondary">
      {title && <div><span className="text-text-tertiary">Title</span> · {title}</div>}
      {types.length > 0 && (
        <div>
          <span className="text-text-tertiary">Type</span> · {types.join(" + ")}
        </div>
      )}
      <div>
        <span className="text-text-tertiary">Series</span> · {seriesArr.length}
      </div>
    </div>
  );
}

function MakeDashboardDetails({ input }: { input?: unknown }) {
  if (!input || typeof input !== "object") return null;
  const i = input as {
    title?: string;
    description?: string;
    charts?: Array<{ title?: string }>;
  };

  return (
    <div className="space-y-1 text-text-secondary">
      {i.title && <div className="font-medium text-text-primary">{i.title}</div>}
      {i.description && <div className="text-text-tertiary">{i.description}</div>}
      {Array.isArray(i.charts) && i.charts.length > 0 && (
        <div className="pt-1">
          <div className="text-text-tertiary">
            {i.charts.length} {i.charts.length === 1 ? "chart" : "charts"}
          </div>
          <ul className="space-y-0.5 pl-3">
            {i.charts.map((c, idx) => (
              <li key={idx} className="text-text-primary">
                {c.title || `Chart ${idx + 1}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function GenericDetails({ input, output }: { input?: unknown; output?: unknown }) {
  const showInput = !isEmptyValue(input);
  const showOutput = !isEmptyValue(output);
  return (
    <>
      {showInput && (
        <details open className="mb-2">
          <summary className="cursor-pointer text-text-tertiary">input</summary>
          <pre className="mt-1 overflow-x-auto rounded bg-background/50 p-2 text-text-secondary">
            {JSON.stringify(input, null, 2)}
          </pre>
        </details>
      )}
      {showOutput && (
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

// ── Helpers ────────────────────────────────────────────────────────

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

function prettifyConnectorType(type?: string): string | undefined {
  if (!type) return undefined;
  const map: Record<string, string> = {
    postgres: "Postgres",
    mysql: "MySQL",
    stripe: "Stripe",
    shopify: "Shopify",
    hubspot: "HubSpot",
    "google-ads": "Google Ads",
    "facebook-ads": "Facebook Ads",
    salesforce: "Salesforce",
    mailchimp: "Mailchimp",
  };
  return map[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}
