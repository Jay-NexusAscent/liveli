"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersIcon } from "@/components/icons";
import {
  applyChartFormat,
  readChartFormat,
  specHasAxes,
  type ChartFormatState,
  type ValueFormatKind,
} from "@/lib/dashboards/chart-spec-edit";
import { SUPPORTED_CURRENCIES } from "@/lib/workspace-settings";
import { currencySymbolFor } from "@/lib/workspace-format";

const FORMAT_OPTIONS: { value: ValueFormatKind; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
];

/**
 * Inline editor for a chart's axis titles + value-format override.
 *
 * Click the sliders button to open a popover; edit x/y axis titles, the
 * value format (number / currency / percent), the currency code, and a
 * unit suffix; Apply writes the changes back onto a fresh spec via
 * {@link applyChartFormat} and hands it to `onApply`. The parent is
 * responsible for persisting (PATCH a saved chart, or splice the spec
 * into a dashboard's charts array).
 *
 * Mirrors the SizePicker / AddChartPicker interaction — click-outside-
 * to-close via a document mousedown listener registered only while open
 * — so the dashboard's small popovers behave consistently.
 */
export function ChartFormatPopover({
  spec,
  workspaceCurrency,
  workspaceLocale,
  onApply,
  ariaLabel = "Edit axes and value format",
}: {
  spec: unknown;
  workspaceCurrency: string;
  workspaceLocale: string;
  onApply: (nextSpec: unknown) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ChartFormatState>(() =>
    readChartFormat(spec)
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hasAxes = specHasAxes(spec);

  // Re-seed the draft from the live spec each time the popover opens, so
  // a previous Cancel (or an edit applied elsewhere) doesn't leave stale
  // values in the form.
  useEffect(() => {
    if (open) setDraft(readChartFormat(spec));
  }, [open, spec]);

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

  const workspaceSymbol = currencySymbolFor(workspaceCurrency, workspaceLocale);

  const apply = () => {
    onApply(applyChartFormat(spec, draft));
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
      >
        <SlidersIcon size={18} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-surface p-3 shadow-lg">
          {hasAxes && (
            <div className="space-y-2.5">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-text-secondary">
                  X-axis title
                </span>
                <input
                  value={draft.xName}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, xName: e.target.value }))
                  }
                  placeholder="e.g. Date"
                  className="w-full rounded-md border border-border bg-elevated px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-text-secondary">
                  Y-axis title
                </span>
                <input
                  value={draft.yName}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, yName: e.target.value }))
                  }
                  placeholder="e.g. Revenue (£)"
                  className="w-full rounded-md border border-border bg-elevated px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </label>
            </div>
          )}

          <div className={hasAxes ? "mt-3" : ""}>
            <span className="mb-1 block text-[12px] font-medium text-text-secondary">
              Value format
            </span>
            <div className="grid grid-cols-4 gap-1">
              {FORMAT_OPTIONS.map((opt) => {
                const active = draft.format === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      setDraft((d) => ({ ...d, format: opt.value }))
                    }
                    aria-pressed={active}
                    className={`rounded-md px-1.5 py-1.5 text-[12px] font-medium transition-colors ${
                      active
                        ? "bg-accent-muted text-accent"
                        : "bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {draft.format === "currency" && (
            <label className="mt-3 block">
              <span className="mb-1 block text-[12px] font-medium text-text-secondary">
                Currency
              </span>
              <select
                value={draft.currency}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, currency: e.target.value }))
                }
                className="w-full rounded-md border border-border bg-elevated px-2.5 py-1.5 text-[13px] text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="">
                  Workspace default ({workspaceSymbol} {workspaceCurrency})
                </option>
                {SUPPORTED_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {currencySymbolFor(code, workspaceLocale)} {code}
                  </option>
                ))}
              </select>
            </label>
          )}

          {draft.format === "number" && (
            <label className="mt-3 block">
              <span className="mb-1 block text-[12px] font-medium text-text-secondary">
                Unit suffix
              </span>
              <input
                value={draft.unit}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, unit: e.target.value }))
                }
                placeholder="e.g. kg, ms"
                maxLength={8}
                className="w-full rounded-md border border-border bg-elevated px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
              />
            </label>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded-md border border-accent bg-accent-muted px-2.5 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-hover"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
