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

// Schemas mirror make-dashboard.ts. Inline (not imported) for the same
// Gemini function-declaration robustness reasons.
const SeriesSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["bar", "line", "pie", "donut", "scatter", "area", "kpi"]),
  // Optional (mirrors make-dashboard.ts): filter-wired charts (sourceSql
  // + dataMapping) may omit baked data and have it populated at save
  // time. A ChartSpec-level superRefine below re-requires it for static
  // charts.
  data: z.array(z.number()).max(10_000).optional(),
  smooth: z.boolean().optional(),
  stack: z.string().optional(),
  format: z.enum(["number", "currency", "percent"]).optional(),
  unit: z.string().max(8).optional(),
  delta: z.number().optional(),
  deltaLabel: z.string().max(40).optional(),
});

const AxisSchema = z.object({
  type: z.enum(["category", "value", "time", "log"]),
  data: z.array(z.string()).max(10_000).optional(),
  name: z.string().optional(),
});

const EChartsOption = z.object({
  title: z.object({ text: z.string(), subtext: z.string().optional() }).optional(),
  tooltip: z.object({ trigger: z.enum(["axis", "item", "none"]).optional() }).optional(),
  legend: z.object({ data: z.array(z.string()).optional() }).optional(),
  xAxis: AxisSchema.optional(),
  yAxis: AxisSchema.optional(),
  series: z.array(SeriesSchema).min(1).max(8),
});

// Per-chart filter re-render shape — see make-dashboard.ts for the
// full semantics. The xAxis is optional because KPI charts have no
// axis; series is required because every chart has at least one
// series and we need to know which column populates it.
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
  // See make-dashboard.ts for full colSpan semantics. Same enum; the
  // model can revise sizes per chart when the user asks ("make the
  // revenue chart full-width", "shrink the KPI cards").
  colSpan: z.enum(COL_SPAN_VALUES).optional(),
  // ─── filter-driven re-render (LIVELI-122 Phase 2) ─────────────────
  // BOTH must be present for the render endpoint to re-run the chart;
  // partial config falls back to static rendering. Omit both for
  // charts that don't depend on filters.
  sourceSql: z.string().min(1).optional(),
  dataMapping: DataMappingSchema.optional(),
}).superRefine((chart, ctx) => {
  // Mirror make-dashboard.ts: data is schema-optional so filter-wired
  // charts can defer to save-time population, but a STATIC chart (no
  // sourceSql + dataMapping pair) must carry its own data.
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
// Flat single-object shape because Gemini's Schema proto rejects
// z.union(). The handler narrows back to the strict FilterDef union
// via the shared narrowFilter helper.

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
  label: z.string().min(1).max(60),
  column: z.string().optional(),
  options: z.array(z.string()).max(200).optional(),
  defaultDateRange: DateRangeDefault.optional(),
  defaultGranularity: z.enum(["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]).optional(),
  defaultSelect: z.string().optional(),
  defaultMultiSelect: z.array(z.string()).max(200).optional(),
});

const Input = z.object({
  dashboardId: z
    .string()
    .min(1)
    .describe("ID of the existing dashboard to update. From the edit context."),
  title: z.string().min(1).max(120).describe("Updated dashboard title."),
  description: z.string().max(280).optional(),
  charts: z
    .array(ChartSpec)
    .min(1)
    .max(8)
    .describe(
      "FULL replacement list of charts that compose this dashboard. Include EVERY chart that should be on the dashboard, not just the changed ones."
    ),
  filters: z
    .array(FilterInputSchema)
    .max(6)
    .optional()
    .describe(
      "FULL replacement list of dashboard filters. To keep existing filters, repeat them. To remove all filters, pass [] (or omit and the dashboard's filters[] is cleared)."
    ),
});

// Same chart-input normalization as make-dashboard.ts — handles the
// model misplacing series/axes at the top level of each chart entry.
const CHART_ECHARTS_KEYS = ["series", "xAxis", "yAxis", "tooltip", "legend", "grid"] as const;

function normalizeInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (!Array.isArray(r.charts)) return r;
  r.charts = (r.charts as unknown[]).map((c) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) return c;
    const chart = { ...(c as Record<string, unknown>) };
    const existing =
      chart.echartsOption &&
      typeof chart.echartsOption === "object" &&
      !Array.isArray(chart.echartsOption)
        ? { ...(chart.echartsOption as Record<string, unknown>) }
        : {};
    for (const key of CHART_ECHARTS_KEYS) {
      if (key in chart && !(key in existing)) {
        existing[key] = chart[key];
        delete chart[key];
      }
    }
    chart.echartsOption = existing;
    return chart;
  });
  return r;
}

/** Mirrors make-dashboard.ts — true if any series lacks usable data. */
function seriesMissingData(echartsOption: { series: Array<{ data?: number[] }> }): boolean {
  return echartsOption.series.some((s) => !s.data || s.data.length === 0);
}

export const updateDashboardTool: ToolDefinition = {
  name: "update_dashboard",
  description:
    "Update an EXISTING dashboard's title, description, FULL chart list, and FULL filter list. Use when the user is editing a dashboard and asks for changes — the `dashboardId` comes from the edit context. Both `charts` and `filters` REPLACE the existing lists entirely, so include every chart and filter that should be on the dashboard after the edit (not just the changed ones). Do NOT use to create a new dashboard — use `make_dashboard` for that.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { dashboardId, title, description, charts, filters } = Input.parse(normalizeInput(raw));
    const narrowedFilters: FilterDef[] = (filters ?? []).map(narrowFilter);
    const ref = dashboardsIn(ctx.clientId, ctx.workspaceId).doc(dashboardId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(
        `Dashboard ${dashboardId} not found in this workspace — it may have been deleted. Cannot update.`
      );
    }
    const chartSpecs = await Promise.all(
      charts.map(async (c, i) => {
        // Populate a filter-wired chart's first-paint data at save time
        // when it was omitted — same rationale as make-dashboard.ts (the
        // dashboards page renders the stored spec on mount, not /render).
        // Best-effort: failure leaves the static spec and still saves.
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
            console.warn("[update_dashboard] save-time data population failed", {
              chartTitle: c.title,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return {
          order: i,
          title: c.title,
          spec,
          ...(c.colSpan ? { colSpan: c.colSpan } : {}),
          ...(c.sourceSql ? { sourceSql: c.sourceSql } : {}),
          ...(c.dataMapping ? { dataMapping: c.dataMapping } : {}),
        };
      })
    );
    await ref.update({
      title,
      description: description ?? null,
      charts: chartSpecs,
      // Always write filters — when caller passes [] (or omits, → []
      // after narrowFilter map) we explicitly clear the field rather
      // than leave a stale list. This matches the FULL-replacement
      // semantic already used for charts.
      filters: narrowedFilters,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      content: {
        ok: true,
        dashboardId,
        title,
        chartCount: charts.length,
        filterCount: narrowedFilters.length,
      },
      clientRender: {
        kind: "dashboard",
        dashboardId,
        title,
        description: description ?? undefined,
        charts: chartSpecs,
      },
    };
  },
};
