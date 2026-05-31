/**
 * Pure helpers for the inline chart format editor (axis titles +
 * value-format override). Used by both edit surfaces on the Dashboards
 * page: dashboard tiles in edit mode and the standalone saved-charts
 * grid. Kept React-free so the logic is trivially testable and the same
 * read/apply round-trips through both a dashboard's inline charts and a
 * saved chart's PATCH body.
 *
 * The chart spec is an ECharts option object. We touch only four things:
 * `xAxis.name`, `yAxis.name`, and the value-format hints
 * (`format` / `currency` / `unit`) which we write onto EVERY series so
 * the renderer's value formatter (chart-renderer.tsx) picks them up
 * uniformly. Everything else passes through untouched.
 */

/** "auto" means no explicit value format — the renderer leaves the axis raw. */
export type ValueFormatKind = "auto" | "number" | "currency" | "percent";

export interface ChartFormatState {
  /** X-axis title. Empty string → no title. */
  xName: string;
  /** Y-axis title. Empty string → no title. */
  yName: string;
  /** Value-format type applied to every series. */
  format: ValueFormatKind;
  /** ISO 4217 code, or "" for the workspace default currency. */
  currency: string;
  /** Optional suffix appended to plain numbers (e.g. "kg", "ms"). */
  unit: string;
}

type SpecRecord = Record<string, unknown>;

function asRecord(value: unknown): SpecRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as SpecRecord) }
    : {};
}

/**
 * Does this spec have cartesian axes (so axis-title fields make sense)?
 * KPI and pie/donut charts have no axes — the editor hides the axis
 * inputs for those.
 */
export function specHasAxes(spec: unknown): boolean {
  const s = asRecord(spec);
  const firstType = Array.isArray(s.series)
    ? (s.series[0] as { type?: string } | undefined)?.type
    : undefined;
  if (firstType === "kpi" || firstType === "pie" || firstType === "donut") {
    return false;
  }
  return Boolean(s.xAxis || s.yAxis);
}

/** Read the current editor state out of a stored chart spec. */
export function readChartFormat(spec: unknown): ChartFormatState {
  const s = asRecord(spec);
  const xAxis = asRecord(s.xAxis);
  const yAxis = asRecord(s.yAxis);
  const series0 = Array.isArray(s.series)
    ? (s.series[0] as Record<string, unknown> | undefined)
    : undefined;
  const fmt = series0?.format;
  return {
    xName: typeof xAxis.name === "string" ? xAxis.name : "",
    yName: typeof yAxis.name === "string" ? yAxis.name : "",
    format:
      fmt === "number" || fmt === "currency" || fmt === "percent"
        ? fmt
        : "auto",
    currency: typeof series0?.currency === "string" ? series0.currency : "",
    unit: typeof series0?.unit === "string" ? series0.unit : "",
  };
}

function setAxisName(axis: unknown, name: string): unknown {
  const trimmed = name.trim();
  // Don't conjure an axis that didn't exist just to clear a name.
  if (!axis && !trimmed) return axis;
  const out = asRecord(axis);
  if (trimmed) out.name = trimmed;
  else delete out.name;
  return out;
}

function applySeriesFormat(
  series: unknown,
  state: ChartFormatState
): unknown {
  const out = asRecord(series);
  if (state.format === "auto") {
    delete out.format;
    delete out.currency;
    delete out.unit;
    return out;
  }
  out.format = state.format;
  // Currency code only meaningful for currency format; "" = workspace default.
  if (state.format === "currency" && state.currency) out.currency = state.currency;
  else delete out.currency;
  // Unit suffix only meaningful for plain numbers.
  if (state.format === "number" && state.unit.trim()) out.unit = state.unit.trim();
  else delete out.unit;
  return out;
}

/**
 * Apply the editor state back onto a spec, returning a new spec object.
 * Pure — does not mutate the input. Axis names are set on whichever
 * axes exist (callers gate axis editing via {@link specHasAxes}); the
 * value-format hints are written onto every series.
 */
export function applyChartFormat(
  spec: unknown,
  state: ChartFormatState
): unknown {
  const s = asRecord(spec);
  s.xAxis = setAxisName(s.xAxis, state.xName);
  s.yAxis = setAxisName(s.yAxis, state.yName);
  if (Array.isArray(s.series)) {
    s.series = s.series.map((ser) => applySeriesFormat(ser, state));
  }
  return s;
}
