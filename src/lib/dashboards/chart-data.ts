/**
 * Shared chart-data assembly for dashboard filters (LIVELI-122).
 *
 * `rebuildChartSpec` takes a chart's stored ECharts spec as a template
 * and swaps the DATA positions (xAxis.data + each series[].data) with
 * column arrays pulled out of a SQL result set, per the chart's
 * `dataMapping`. Everything else the agent set (title, tooltip, legend,
 * series types, colours, axis types) is preserved untouched.
 *
 * Two callers share this:
 *   1. The `/render` endpoint — re-runs a chart under new filter values.
 *   2. `make_dashboard` — populates a filter-wired chart's initial
 *      `series[].data` at SAVE time, using the filter defaults, so the
 *      dashboard's first paint isn't blank. (The dashboards page renders
 *      the stored static spec on mount; it only calls `/render` when the
 *      user changes a filter.)
 */

import type { ChartDataMapping } from "./types";

/**
 * Rebuild a chart spec by pulling column arrays from the result rows
 * and slotting them into the positions declared by dataMapping.
 *
 * The existing spec is used as a template — we preserve everything
 * the agent set (title, tooltip, legend, series types, etc.) and
 * only replace the data positions. That means visualisation choices
 * (chart type, colours, axis types) survive re-renders intact.
 *
 * Returns the original spec untouched if any dataMapping column
 * isn't present in the result — defensive against schema drift.
 */
export function rebuildChartSpec(
  originalSpec: unknown,
  mapping: ChartDataMapping,
  rows: Record<string, unknown>[]
): unknown {
  if (!originalSpec || typeof originalSpec !== "object") return originalSpec;
  const spec = { ...(originalSpec as Record<string, unknown>) };

  // Build column arrays from the rows. Map<columnName, value[]>.
  const columns = new Map<string, unknown[]>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!columns.has(k)) columns.set(k, []);
      columns.get(k)!.push(v);
    }
  }

  // xAxis.data
  if (mapping.xAxis) {
    const xCol = columns.get(mapping.xAxis.dataColumn);
    if (xCol) {
      const existingXAxis = (spec.xAxis as Record<string, unknown> | undefined) ?? {};
      spec.xAxis = {
        ...existingXAxis,
        data: xCol.map((v) => (v == null ? "" : String(v))),
      };
    }
  }

  // series[].data — preserve existing series structure, only swap data
  if (Array.isArray(spec.series)) {
    spec.series = (spec.series as Array<Record<string, unknown>>).map((s, i) => {
      const seriesMap = mapping.series[i];
      if (!seriesMap) return s;
      const col = columns.get(seriesMap.dataColumn);
      if (!col) return s;
      // Coerce non-numeric values to 0 for safety — ECharts series.data
      // expects numbers. NaN-shaped values render as gaps in line
      // charts and 0-height bars; both acceptable degradations.
      const numericCol = col.map((v) => (typeof v === "number" ? v : Number(v) || 0));
      return {
        ...s,
        ...(seriesMap.name ? { name: seriesMap.name } : {}),
        data: numericCol,
      };
    });
  }

  return spec;
}
