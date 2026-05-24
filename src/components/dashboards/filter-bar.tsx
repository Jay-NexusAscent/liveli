"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "@/components/icons";
import type {
  DateRangeFilterDef,
  DateRangePreset,
  FilterDef,
  FilterValues,
  Granularity,
  GranularityFilterDef,
  MultiSelectFilterDef,
  SelectFilterDef,
} from "@/lib/dashboards/types";

/**
 * Dashboard-wide filter bar. Renders one control per FilterDef and
 * fires `onChange` with a fresh FilterValues object whenever the user
 * picks something.
 *
 * Design choices for v1:
 *
 *   - **date_range**: preset dropdown only ("Last 7 days", "Last 30
 *     days", …). Custom-date-range picker is deferred — the agent can
 *     still set `mode: "custom"` defaults from a chart's SQL, but the
 *     UI doesn't let the end user pick custom dates yet. When a
 *     dashboard's authored default is `mode: "custom"`, the UI shows
 *     a non-editable "Custom range" indicator and clicking it falls
 *     back to "Last 30 days".
 *
 *   - **granularity / select**: native `<select>` — platform-correct
 *     keyboard handling, no custom state machine, no a11y rework.
 *
 *   - **multi_select**: custom popover with checkboxes. Native
 *     `<select multiple>` is unusable on touch and looks dated.
 *
 * The "Updating…" indicator next to the bar makes the in-flight
 * re-render visible without disabling controls — the user can still
 * change other filters mid-request; the page is responsible for
 * coalescing requests (typically by tracking the latest in-flight
 * request id and ignoring stale responses).
 */
export function FilterBar({
  filters,
  values,
  onChange,
  isUpdating,
  onReset,
}: {
  filters: FilterDef[];
  values: FilterValues;
  onChange: (next: FilterValues) => void;
  isUpdating?: boolean;
  /** Optional handler — when present, renders a small "Reset" affordance. */
  onReset?: () => void;
}) {
  if (filters.length === 0) return null;

  /**
   * Apply a single-filter change and bubble the full FilterValues
   * object up. Spreading the previous values means filter id `X` can
   * change without disturbing filter id `Y` — even though React state
   * updates are immutable, we still want explicit copy semantics here
   * so it's obvious at the call site that nothing else changed.
   */
  const update = (id: string, value: FilterValues[string]) => {
    onChange({ ...values, [id]: value });
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {filters.map((f) => (
        <FilterControl
          key={f.id}
          def={f}
          value={values[f.id]}
          onChange={(v) => update(f.id, v)}
        />
      ))}
      {isUpdating && (
        <span
          className="ml-1 inline-flex items-center gap-1.5 text-[12px] text-text-tertiary"
          aria-live="polite"
        >
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
            aria-hidden="true"
          />
          Updating…
        </span>
      )}
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className="ml-auto rounded-md px-2 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
        >
          Reset
        </button>
      )}
    </div>
  );
}

/**
 * Dispatch a single filter to its type-specific control. Kept as one
 * switch so adding a new filter type means touching exactly this file
 * (plus the type itself in lib/dashboards/types.ts).
 */
function FilterControl({
  def,
  value,
  onChange,
}: {
  def: FilterDef;
  value: FilterValues[string];
  onChange: (v: FilterValues[string]) => void;
}) {
  switch (def.type) {
    case "date_range":
      return (
        <DateRangeControl
          def={def}
          value={value as { mode: "preset"; preset: DateRangePreset } | { mode: "custom"; start: string; end: string } | undefined}
          onChange={onChange}
        />
      );
    case "granularity":
      return (
        <GranularityControl
          def={def}
          value={value as Granularity | undefined}
          onChange={onChange}
        />
      );
    case "select":
      return (
        <SelectControl
          def={def}
          value={value as string | null | undefined}
          onChange={onChange}
        />
      );
    case "multi_select":
      return (
        <MultiSelectControl
          def={def}
          value={(value as string[] | undefined) ?? []}
          onChange={onChange}
        />
      );
  }
}

// ── date_range ────────────────────────────────────────────────────────

const DATE_RANGE_PRESET_LABELS: Record<DateRangePreset, string> = {
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  last_year: "Last year",
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  this_year: "This year",
  year_to_date: "Year to date",
};

const DATE_RANGE_PRESET_ORDER: DateRangePreset[] = [
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_year",
  "this_month",
  "last_month",
  "this_quarter",
  "this_year",
  "year_to_date",
];

function DateRangeControl({
  def,
  value,
  onChange,
}: {
  def: DateRangeFilterDef;
  value:
    | { mode: "preset"; preset: DateRangePreset }
    | { mode: "custom"; start: string; end: string }
    | undefined;
  onChange: (v: { mode: "preset"; preset: DateRangePreset }) => void;
}) {
  // When the stored value is a custom range, we don't have a UI to
  // edit it yet (custom-range picker is deferred). Show the preset
  // dropdown with no selection; picking a preset replaces the custom
  // range. The user's option to "go back to custom" requires the
  // Reset affordance on the bar.
  const isCustom = value?.mode === "custom";
  const currentPreset = value?.mode === "preset" ? value.preset : "";

  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-text-secondary">
      <span>{def.label}</span>
      <select
        className="rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-text-primary focus:border-accent focus:outline-none"
        value={currentPreset}
        onChange={(e) => {
          const preset = e.target.value as DateRangePreset;
          if (!preset) return;
          onChange({ mode: "preset", preset });
        }}
        aria-label={def.label}
      >
        {isCustom && (
          // Placeholder option — selecting any real preset replaces
          // the custom range. We render this as the selected option
          // when value is custom so the user sees what state they're
          // in rather than a confusing "Last 7 days" that isn't true.
          <option value="">Custom range</option>
        )}
        {DATE_RANGE_PRESET_ORDER.map((p) => (
          <option key={p} value={p}>
            {DATE_RANGE_PRESET_LABELS[p]}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── granularity ───────────────────────────────────────────────────────

const GRANULARITY_LABELS: Record<Granularity, string> = {
  DAY: "Day",
  WEEK: "Week",
  MONTH: "Month",
  QUARTER: "Quarter",
  YEAR: "Year",
};

const GRANULARITY_ORDER: Granularity[] = ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"];

function GranularityControl({
  def,
  value,
  onChange,
}: {
  def: GranularityFilterDef;
  value: Granularity | undefined;
  onChange: (v: Granularity) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-text-secondary">
      <span>{def.label}</span>
      <select
        className="rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-text-primary focus:border-accent focus:outline-none"
        value={value ?? def.defaultValue}
        onChange={(e) => onChange(e.target.value as Granularity)}
        aria-label={def.label}
      >
        {GRANULARITY_ORDER.map((g) => (
          <option key={g} value={g}>
            {GRANULARITY_LABELS[g]}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── select ────────────────────────────────────────────────────────────

const ANY_VALUE_SENTINEL = "__any__";

function SelectControl({
  def,
  value,
  onChange,
}: {
  def: SelectFilterDef;
  value: string | null | undefined;
  // `null` means "no filter applied" — the server treats it as TRUE.
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-text-secondary">
      <span>{def.label}</span>
      <select
        className="rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-text-primary focus:border-accent focus:outline-none"
        // Convert null ↔ a string sentinel for the native <select> —
        // option values can't be null in HTML.
        value={value == null ? ANY_VALUE_SENTINEL : value}
        onChange={(e) =>
          onChange(e.target.value === ANY_VALUE_SENTINEL ? null : e.target.value)
        }
        aria-label={def.label}
      >
        <option value={ANY_VALUE_SENTINEL}>Any</option>
        {def.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── multi_select ──────────────────────────────────────────────────────

function MultiSelectControl({
  def,
  value,
  onChange,
}: {
  def: MultiSelectFilterDef;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click-outside-to-close. Listener only registered while open so we
  // don't pay the cost on every dashboard with closed filter bars.
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

  const toggle = (option: string) => {
    if (value.includes(option)) {
      onChange(value.filter((v) => v !== option));
    } else {
      onChange([...value, option]);
    }
  };

  // Button label summarises the selection. "All" when nothing is
  // checked (which matches server semantics: empty array → no filter
  // applied → every row passes). Single value: show it. Multiple: "n
  // selected".
  let buttonLabel: string;
  if (value.length === 0) {
    buttonLabel = "All";
  } else if (value.length === 1) {
    buttonLabel = value[0];
  } else {
    buttonLabel = `${value.length} selected`;
  }

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-2 text-[12px] text-text-secondary">
      <span>{def.label}</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${def.label}, currently ${buttonLabel}`}
        className="rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-text-primary transition-colors hover:border-accent focus:border-accent focus:outline-none"
      >
        {buttonLabel}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={def.label}
          aria-multiselectable="true"
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {def.options.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-text-tertiary">No options.</p>
          )}
          {def.options.map((opt) => {
            const selected = value.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => toggle(opt)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                  selected
                    ? "bg-accent-muted text-accent"
                    : "text-text-secondary hover:bg-hover hover:text-text-primary"
                }`}
              >
                <span className="truncate">{opt}</span>
                {selected && <CheckIcon className="text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
