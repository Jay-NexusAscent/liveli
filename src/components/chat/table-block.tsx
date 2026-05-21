"use client";

import { useMemo, useState } from "react";

interface TableBlockProps {
  rows: Record<string, unknown>[];
}

/**
 * Renders run_sql result rows as a scrollable table. Receives rows
 * already sanitized by lib/bigquery.ts:sanitizeBqValue, so every cell is
 * a JSON-friendly primitive / array / object.
 *
 * Sort + truncation defaults are tuned for the typical agent reply
 * (10–100 rows, 4–10 cols). Larger results are still rendered but the
 * fixed max-height contains the scroll.
 */
export function TableBlock({ rows }: TableBlockProps) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const columns = useMemo(() => {
    if (rows.length === 0) return [];
    const cols = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) cols.add(k);
    return Array.from(cols);
  }, [rows]);

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
                    {formatCell(row[col])}
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
 * string:
 *   - ISO timestamps get formatted via Intl.DateTimeFormat in the
 *     user's locale (avoids showing raw "2026-05-18T11:55:00.000Z"
 *     to non-technical users)
 *   - Date-only ISO ("2026-05-18") drops the time portion
 *   - null/undefined become an em-dash
 *   - Objects/arrays JSON-stringify (rare; sanitizeBqValue usually
 *     primitivises ahead of us)
 *
 * The Intl format is intentionally locale-aware (`undefined` for the
 * first arg) — UK users see "18 May 2026, 11:55", US users see
 * "May 18, 2026, 11:55". Seconds and milliseconds are dropped on
 * purpose: in 99% of agent-generated tables the second-level
 * precision is noise, and dropping it keeps cells narrow.
 */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" && ISO_DATE_RE.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      const isDateOnly = !value.includes("T");
      return new Intl.DateTimeFormat(
        undefined,
        isDateOnly
          ? { year: "numeric", month: "short", day: "numeric" }
          : {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }
      ).format(d);
    }
  }
  // Numeric formatting: round IEEE-754 noise to 2 decimals max, then
  // apply locale thousands separator. Examples:
  //   18197.840000000004 → "18,197.84"
  //   15825.520000000002 → "15,825.52"
  //   16596.27           → "16,596.27"
  //   1000000            → "1,000,000"
  //   42                 → "42"
  // Integer-valued floats render without decimals; fractional values
  // keep up to 2 decimal places (matches typical financial display
  // conventions). We do NOT abbreviate (M/K/B) here because table
  // cells should be precise — abbreviation is for KPI tiles only.
  if (typeof value === "number" && Number.isFinite(value)) {
    const isInteger = Number.isInteger(value);
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: isInteger ? 0 : 2,
    });
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
