"use client";

import { useMemo, useState } from "react";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceSettings,
} from "@/lib/workspace-settings";
import {
  formatCurrencyWithToken,
  formatDateWithToken,
  formatNumberWithToken,
  isCurrencyColumn,
} from "@/lib/workspace-format";

interface TableBlockProps {
  rows: Record<string, unknown>[];
  /**
   * Workspace regional preferences — drives the locale, timezone,
   * dateFormat token, numberFormat token, and currency used when
   * rendering individual cells. Optional so legacy callers (e.g.
   * stored chat replays without a settings context) still render with
   * defaults rather than crashing.
   */
  settings?: WorkspaceSettings;
}

/**
 * Renders run_sql result rows as a scrollable table. Receives rows
 * already sanitized by lib/bigquery.ts:sanitizeBqValue, so every cell is
 * a JSON-friendly primitive / array / object.
 *
 * Sort + truncation defaults are tuned for the typical agent reply
 * (10–100 rows, 4–10 cols). Larger results are still rendered but the
 * fixed max-height contains the scroll.
 *
 * Cell formatting follows the workspace settings:
 *   - ISO date / timestamp cells → `dateFormat` token, `timezone`
 *   - Numeric cells in a "currency-named" column → workspace `currency`
 *     + `numberFormat` token (see `isCurrencyColumn` heuristic)
 *   - All other numeric cells → `numberFormat` token
 *
 * The column-type signal is derived from the column NAME, since
 * run_sql results don't carry BigQuery type metadata down to the
 * client. A separate enhancement would propagate types through the
 * wire format; in the meantime, name-shape covers the common cases.
 */
export function TableBlock({ rows, settings = DEFAULT_WORKSPACE_SETTINGS }: TableBlockProps) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const columns = useMemo(() => {
    if (rows.length === 0) return [];
    const cols = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) cols.add(k);
    return Array.from(cols);
  }, [rows]);

  // Precompute which columns are currency-typed so we don't re-run the
  // regex per cell. Stable across rows because columns are stable.
  const currencyColumns = useMemo(() => {
    const out = new Set<string>();
    for (const col of columns) if (isCurrencyColumn(col)) out.add(col);
    return out;
  }, [columns]);

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = av > bv ? 1 : -1;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  if (rows.length === 0) {
    return (
      <div className="my-3 rounded-md border border-border bg-elevated/50 px-3 py-2 text-[12px] text-text-tertiary">
        No rows.
      </div>
    );
  }

  const toggleSort = (col: string) => {
    if (sortKey === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col);
      setSortDir("asc");
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border">
      <div className="max-h-[400px] overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-elevated">
            <tr>
              {columns.map((col) => {
                const isSorted = sortKey === col;
                return (
                  <th
                    key={col}
                    onClick={() => toggleSort(col)}
                    className="cursor-pointer border-b border-border px-3 py-2 text-left font-medium text-text-secondary hover:text-text-primary"
                  >
                    <span className="inline-flex items-center gap-1">
                      {formatHeader(col)}
                      {isSorted && (
                        <span className="text-text-tertiary">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, i) => (
              <tr key={i} className="border-b border-border/50 last:border-b-0 hover:bg-hover/40">
                {columns.map((col) => (
                  <td
                    key={col}
                    className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-text-primary"
                  >
                    {formatCell(row[col], col, settings, currencyColumns)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border bg-elevated/50 px-3 py-1.5 text-[11px] text-text-tertiary">
        {rows.length} {rows.length === 1 ? "row" : "rows"}
      </div>
    </div>
  );
}

/**
 * Convert a snake_case (or already-spaced) SQL column name into a
 * customer-friendly Title Case header. Examples:
 *   time_bucket     → "Time Bucket"
 *   order_count     → "Order Count"
 *   five_min_window → "Five Min Window"
 *
 * The agent writes snake_case aliases in SQL by convention (SQL
 * identifiers don't take spaces without backtick-quoting). Rather
 * than try to force the agent to emit display-friendly aliases
 * (fragile, and produces ugly SQL), we do the cosmetic conversion
 * one-time at render time. Every current and future table benefits.
 *
 * Empty/falsy values pass through unchanged. Mid-word casing is
 * preserved (so `customerID` stays `CustomerID`, not `Customerid`).
 */
function formatHeader(col: string): string {
  if (!col) return col;
  return col
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Strict ISO-8601 matcher — date-only or full timestamp with optional
 * fractional seconds and optional Z/+HH:MM offset. Anchored on both
 * sides so arbitrary strings that contain a date-looking substring
 * (e.g. log lines, descriptions) don't get rewritten.
 */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Cell renderer. Turns raw run_sql values into a customer-friendly
 * string per the workspace settings:
 *   - ISO timestamps  → `formatDateWithToken` (respects dateFormat
 *     token and timezone). Date-only strings (no `T` component) get
 *     the date portion only; full timestamps add HH:MM.
 *   - Numeric values in a currency-named column → `formatCurrency-
 *     WithToken` (workspace currency + numberFormat token; locale
 *     drives symbol placement).
 *   - Other numeric values → `formatNumberWithToken` (explicit
 *     separator pick).
 *   - null/undefined → em-dash.
 *   - Objects/arrays → JSON (rare; sanitizeBqValue usually
 *     primitivises ahead of us).
 *
 * Trade-off note on currency: `Intl` couples currency-symbol
 * placement to the locale, so locale ultimately drives the symbol's
 * position even when the user picks a numberFormat token that
 * disagrees. The digit separators inside the formatted currency
 * string DO match the user's pick — see `formatCurrencyWithToken`.
 */
function formatCell(
  value: unknown,
  column: string,
  settings: WorkspaceSettings,
  currencyColumns: Set<string>
): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" && ISO_DATE_RE.test(value)) {
    const isDateOnly = !value.includes("T");
    return formatDateWithToken(value, settings.dateFormat, settings.timezone, {
      includeTime: !isDateOnly,
      locale: settings.agentLocale,
    });
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (currencyColumns.has(column)) {
      return formatCurrencyWithToken(
        value,
        settings.currency,
        settings.numberFormat,
        settings.agentLocale
      );
    }
    return formatNumberWithToken(value, settings.numberFormat);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
