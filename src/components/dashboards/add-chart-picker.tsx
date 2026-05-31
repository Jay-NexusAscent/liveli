"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, SearchIcon } from "@/components/icons";

export interface PickableChart {
  id: string;
  title: string;
  spec: unknown;
}

/**
 * Add-a-saved-chart control for dashboard edit mode. Click the button
 * to open a searchable list of the workspace's saved charts; picking
 * one fires `onAdd` with that chart and closes the popover.
 *
 * Deliberately mirrors the SizePicker interaction (click-outside-to-
 * close via a document mousedown listener registered only while open)
 * so the dashboard's small popovers behave consistently.
 */
export function AddChartPicker({
  charts,
  onAdd,
}: {
  charts: PickableChart[];
  onAdd: (chart: PickableChart) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  // Focus the search field the moment the popover opens so the user can
  // type immediately without a second click.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return charts;
    return charts.filter((c) => c.title.toLowerCase().includes(q));
  }, [charts, query]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
      >
        <PlusIcon />
        Add chart
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-surface p-1 shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 text-text-tertiary">
            <SearchIcon />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search saved charts…"
              className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-2.5 py-3 text-[13px] text-text-tertiary">
                {charts.length === 0
                  ? "No saved charts yet — save a chart from chat first."
                  : "No charts match your search."}
              </p>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onAdd(c);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                >
                  <PlusIcon />
                  <span className="truncate">{c.title}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
