import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { dashboardsIn } from "@/lib/firestore";
import { safeQuery } from "@/lib/bigquery";
import type { ToolDefinition } from "./types";
import {
  COL_SPAN_VALUES,
  type ChartDataMapping,
  type FilterDef,
} from "@/lib/dashboards/types";
import { narrowFilter } from "@/lib/dashboards/filter-narrow";
import { substituteFilters } from "@/lib/dashboards/sql-template";
import { rebuildChartSpec } from "@/lib/dashboards/chart-data";

/**
 * Reuse the same narrow ECharts spec subset as make_chart. Same Gemini
 * Schema constraints: no z.union(), no z.unknown(). See make-chart.ts
 * for the rationale.
 */
const SeriesSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["bar", "line", "pie", "donut", "scatter", "area", "kpi"]),
  // Optional here (unlike make_chart, where it's always required): a
  // filter-wired chart (sourceSql + dataMapping) can omit baked data and
  // let the make_dashboard handler populate it at save time from the
  // filter defaults. A ChartSpec-level superRefine below re-imposes the
  // requirement for STATIC charts, which have nothing to populate from.
  // null entries = gaps, so series of different lengths can share an
  // x-axis (e.g. actual vs forecast overlay). The renderer skips nulls.
  data: z.array(z.number().nullable()).max(10_000).optional(),
  smooth: z.boolean().optional(),
  stack: z.string().optional(),
  // Value-format hints — see make-chart.ts for full doc. `format` /
  // `unit` format the value axis + tooltip on cartesian charts and the
  // big number on KPI tiles (set "currency"/"percent"/"number" whenever
  // values aren't plain counts); `delta` / `deltaLabel` are KPI-only.
  format: z.enum(["number", "currency", "percent"]).optional(),
  unit: z.string().max(8).optional(),
  delta: z.number().optional(),
  deltaLabel: z.string().max(40).optional(),
  // Per-series currency override (ISO 4217). Optional — falls back to
  // the workspace currency. Only set when this chart's data is in a
  // different currency than the workspace default (parity with
  // make-chart's SeriesSchema).
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO 4217 code")
    .optional(),
});

const AxisSchema = z.object({
  type: z.enum(["category", "value", "time", "log"]),
  data: z.array(z.string()).max(10_000).optional(),
  name: z
    .string()
    .optional()
    .describe(
      "Axis title, e.g. \"Date\" or \"Revenue (£)\". Set on BOTH axes for bar/line/area/scatter charts. Skip for KPI/pie/donut."
    ),
});

const EChartsOption = z.object({
  title: z.object({ text: z.string(), subtext: z.string().optional() }).optional(),
  tooltip: z.object({ trigger: z.enum(["axis", "item", "none"]).optional() }).optional(),
  legend: z.object({ data: z.array(z.string()).optional() }).optional(),
  xAxis: AxisSchema.optional(),
  yAxis: AxisSchema.optional(),
  series: z.array(SeriesSchema).min(1).max(8),
});

/**
 * Per-chart data-mapping schema for filter-driven re-render. Tells the
 * render endpoint how to lift columns out of the substituted SQL's
 * result rows and slot them back into ECharts spec positions.
 *
 * `xAxis.dataColumn` feeds `spec.xAxis.data` (category labels).
 * Each `series[i].dataColumn` feeds `spec.series[i].data` (numeric values).
 * Order of `series[]` here must match order in `echartsOption.series`.
 */
const DataMappingSchema = z.object({
  xAxis: z.object({ dataColumn: z.string().min(1) }).optional(),
  series: z
    .array(
      z.object({
        dataColumn: z.string().min(1),
        name: z.string().optional(),
      })
    )
    .min(1)
    .max(8),
});

const ChartSpec = z.object({
  title: z.string().min(1).max(120),
  echartsOption: EChartsOption,
  // Optional column-span hint controlling tile size on the dashboard
  // grid. The grid is 4 cols wide with 180px row units:
  //   extra-small → 1/4 width × half-height row  (for single-value KPI tiles;
  //                                              avoids wasted vertical space)
  //   small       → 1/4 width × full row         (KPIs with extra detail)
  //   medium      → 1/2 width × full row         (default; default chart size)
  //   large       → full width × full row        (hero charts, wide time series)
  // Missing → "medium" so older dashboards render identically.
  // Use `extra-small` for KPI / single-value charts; the agent should
  // prefer it whenever the chart spec is a single big number rather
  // than a multi-series visualisation.
  colSpan: z.enum(COL_SPAN_VALUES).optional(),
  // ─── filter-driven re-render (LIVELI-122 Phase 2) ─────────────────
  // BOTH fields must be present for the render endpoint to re-run the
  // chart. If either is missing, the chart falls back to its static
  // spec at render time. Charts that don't depend on filters (KPIs
  // over a fixed window, narrative copy embedded as a chart, etc.) can
  // safely omit both.
  /**
   * Parameterised SQL template. Use placeholders of the form
   * `{{filter:<filterId>.<field>}}` where `<filterId>` matches a
   * filter declared in the dashboard's `filters[]` array. Example
   * fields: `.start` / `.end` for date_range, `.values` for
   * multi_select, `.value` for select, no sub-field for granularity.
   */
  sourceSql: z.string().min(1).optional(),
  /** Maps result columns onto chart spec positions. See DataMappingSchema doc. */
  dataMapping: DataMappingSchema.optional(),
}).superRefine((chart, ctx) => {
  // `series[].data` is schema-optional so filter-wired charts can defer
  // it to save-time population (see SeriesSchema). But a STATIC chart —
  // one without BOTH sourceSql and dataMapping — has no source to
  // populate from, so every series must carry its own data. Re-impose
  // that here with a path-pointed, self-correcting message rather than
  // letting the chart save blank.
  const filterWired = Boolean(chart.sourceSql && chart.dataMapping);
  if (filterWired) return;
  chart.echartsOption.series.forEach((s, i) => {
    if (!s.data || s.data.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["echartsOption", "series", i, "data"],
        message:
          "series.data is required for a static chart. Either include the numeric data, or wire the chart to filters by providing BOTH sourceSql and dataMapping (then data may be omitted and is populated on save).",
      });
    }
  });
});

// ─── filter input schema (Gemini-flat shape) ─────────────────────────
//
// FilterDef is a discriminated union of 4 types, but Gemini's Schema
// proto can't represent `z.union()` or `z.discriminatedUnion()`. So we
// expose a flat object covering all 4 variants, with `type` as the
// discriminator and per-variant fields as optionals. The handler
// narrows this back to the strict FilterDef union before persisting.

const DateRangeDefault = z.object({
  mode: z.enum(["preset", "custom"]),
  preset: z
    .enum([
      "last_7_days",
      "last_30_days",
      "last_90_days",
      "last_year",
      "this_month",
      "last_month",
      "this_quarter",
      "this_year",
      "year_to_date",
    ])
    .optional(),
  start: z.string().optional(),
  end: z.string().optional(),
});

const FilterInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .describe("Stable identifier used in sourceSql placeholders, e.g. 'date_range'."),
  type: z.enum(["date_range", "granularity", "select", "multi_select"]),
  label: z.string().min(1).max(60).describe("Display label, e.g. 'Date range'."),
  // select / multi_select only
  column: z
    .string()
    .optional()
    .describe("For select/multi_select: the column being filtered. Ignored for other types."),
  options: z
    .array(z.string())
    .max(200)
    .optional()
    .describe("For select/multi_select: the values the user can pick from."),
  // per-type defaults — model fills in the one matching `type`
  defaultDateRange: DateRangeDefault.optional(),
  defaultGranularity: z.enum(["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]).optional(),
  defaultSelect: z
    .string()
    .optional()
    .describe("For select: default value. Omit for 'no default selected'."),
  defaultMultiSelect: z
    .array(z.string())
    .max(200)
    .optional()
    .describe("For multi_select: default values. Empty array = no filter applied."),
});

const Input = z.object({
  title: z.string().min(1).max(120).describe("Dashboard title"),
  description: z.string().max(280).optional().describe("Optional one-line description"),
  charts: z
    .array(ChartSpec)
    .min(1)
    .max(8)
    .describe("Charts that compose this dashboard (1-8). Each is a full ECharts spec with title."),
  filters: z
    .array(FilterInputSchema)
    .max(6)
    .optional()
    .describe(
      "Dashboard-wide filters. When a filter is declared here, charts can reference its values in their sourceSql via {{filter:<id>.<field>}} placeholders. Up to 6 per dashboard."
    ),
});

/**
 * Same defensive normalization as make-chart.ts: each chart inside a
 * dashboard input gets its top-level ECharts keys moved into
 * `echartsOption` if the model misplaced them. Common failure pattern:
 *   { charts: [{ title, series, yAxis, echartsOption: { xAxis } }] }
 * Should be:
 *   { charts: [{ title, echartsOption: { xAxis, yAxis, series } }] }
 */
const CHART_ECHARTS_KEYS = [
  "series",
  "xAxis",
  "yAxis",
  "tooltip",
  "legend",
  "grid",
] as const;

function normalizeDashboardInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (!Array.isArray(r.charts)) return r;
  let anyMoved = false;
  r.charts = (r.charts as unknown[]).map((c) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) return c;
    const chart = { ...(c as Record<string, unknown>) };
    const existing =
      chart.echartsOption &&
      typeof chart.echartsOption === "object" &&
      !Array.isArray(chart.echartsOption)
        ? { ...(chart.echartsOption as Record<string, unknown>) }
        : {};
    let moved = false;
    for (const key of CHART_ECHARTS_KEYS) {
      if (key in chart && !(key in existing)) {
        existing[key] = chart[key];
        delete chart[key];
        moved = true;
        anyMoved = true;
      }
    }
    chart.echartsOption = existing;
    void moved;
    return chart;
  });
  if (anyMoved) {
    console.warn(
      "[make_dashboard] normalised top-level ECharts keys into chart.echartsOption — model misplaced fields"
    );
  }
  return r;
}

/**
 * True if any series in this chart's ECharts option lacks usable data
 * (absent or empty array). Drives whether the make_dashboard handler
 * runs the chart's sourceSql at save time to fill in the first paint.
 */
function seriesMissingData(echartsOption: {
  series: Array<{ data?: Array<number | null> }>;
}): boolean {
  return echartsOption.series.some((s) => !s.data || s.data.length === 0);
}

export const makeDashboardTool: ToolDefinition = {
  name: "make_dashboard",
  description:
    "Create a dashboard composed of multiple charts in one call. Use this when the user asks for an overview, summary, or report covering several related metrics. The dashboard is saved immediately and visible on the Dashboards tab. Optionally pass `filters[]` to make the dashboard interactive — charts that reference filter placeholders in their `sourceSql` will re-run when the user changes a filter value.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { title, description, charts, filters } = Input.parse(normalizeDashboardInput(raw));
    const narrowedFilters: FilterDef[] = (filters ?? []).map(narrowFilter);
    const docRef = dashboardsIn(ctx.clientId, ctx.workspaceId).doc();
    const chartSpecs = await Promise.all(
      charts.map(async (c, i) => {
        // First paint comes from the STORED static spec — the dashboards
        // page only calls /render when the user changes a filter, not on
        // mount. So a filter-wired chart that omitted its baked
        // `series[].data` would otherwise paint blank. Populate it now by
        // running the chart's sourceSql under the filter DEFAULTS (empty
        // values → narrowFilter defaults), then rebuilding the spec with
        // the results. Best-effort: a failure here leaves the (possibly
        // dataless) static spec in place and still saves the dashboard —
        // the chart fills in the moment the user touches a filter.
        let spec: unknown = c.echartsOption;
        const filterWired = Boolean(c.sourceSql && c.dataMapping);
        if (filterWired && seriesMissingData(c.echartsOption)) {
          try {
            const substituted = substituteFilters(c.sourceSql!, narrowedFilters, {});
            const result = await safeQuery(substituted, {
              maxRows: 1000,
              context: {
                clientId: ctx.clientId,
                workspaceId: ctx.workspaceId,
                userId: ctx.userId,
              },
            });
            spec = rebuildChartSpec(
              c.echartsOption,
              c.dataMapping as ChartDataMapping,
              result.rows
            );
          } catch (err) {
            console.warn("[make_dashboard] save-time data population failed", {
              chartTitle: c.title,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return {
          order: i,
          title: c.title,
          spec,
          // Persist colSpan when the model picked one; the API GET passes
          // it through to the client. Missing = client treats as "medium".
          ...(c.colSpan ? { colSpan: c.colSpan } : {}),
          // Filter-driven re-render fields. Both must be present for the
          // /render endpoint to re-run the chart — partial config (only
          // sourceSql, only dataMapping) falls back to static rendering.
          ...(c.sourceSql ? { sourceSql: c.sourceSql } : {}),
          ...(c.dataMapping ? { dataMapping: c.dataMapping } : {}),
        };
      })
    );
    await docRef.set({
      title,
      description: description ?? null,
      charts: chartSpecs,
      // Only store filters[] when the agent declared any. Dashboards
      // without filters stay byte-identical to pre-Phase-2 docs.
      ...(narrowedFilters.length > 0 ? { filters: narrowedFilters } : {}),
      createdBy: ctx.userId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      content: {
        ok: true,
        dashboardId: docRef.id,
        title,
        chartCount: charts.length,
        filterCount: narrowedFilters.length,
      },
      // Real dashboard render — passes the full chart specs to the
      // client so the chat preview can show a working mini-grid of
      // charts inline. Previously this was a `kind: "chart"` stub with
      // an empty ECharts spec, which rendered as a blank card.
      clientRender: {
        kind: "dashboard",
        dashboardId: docRef.id,
        title,
        description: description ?? undefined,
        charts: chartSpecs,
      },
    };
  },
};
