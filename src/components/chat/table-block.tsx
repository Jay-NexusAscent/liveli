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
                      {col}
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

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
