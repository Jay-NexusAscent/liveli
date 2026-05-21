import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { dashboardsIn } from "@/lib/firestore";
import type { ToolDefinition } from "./types";

/**
 * Reuse the same narrow ECharts spec subset as make_chart. Same Gemini
 * Schema constraints: no z.union(), no z.unknown(). See make-chart.ts
 * for the rationale.
 */
const SeriesSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["bar", "line", "pie", "donut", "scatter", "area", "kpi"]),
  data: z.array(z.number()).max(10_000),
  smooth: z.boolean().optional(),
  stack: z.string().optional(),
  // KPI hints — see make-chart.ts for full doc.
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

const ChartSpec = z.object({
  title: z.string().min(1).max(120),
  echartsOption: EChartsOption,
});

const Input = z.object({
  title: z.string().min(1).max(120).describe("Dashboard title"),
  description: z.string().max(280).optional().describe("Optional one-line description"),
  charts: z
    .array(ChartSpec)
    .min(1)
    .max(8)
    .describe("Charts that compose this dashboard (1-8). Each is a full ECharts spec with title."),
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

export const makeDashboardTool: ToolDefinition = {
  name: "make_dashboard",
  description:
    "Create a dashboard composed of multiple charts in one call. Use this when the user asks for an overview, summary, or report covering several related metrics. The dashboard is saved immediately and visible on the Dashboards tab.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { title, description, charts } = Input.parse(normalizeDashboardInput(raw));
    const docRef = dashboardsIn(ctx.clientId, ctx.workspaceId).doc();
    const chartSpecs = charts.map((c, i) => ({
      order: i,
      title: c.title,
      spec: c.echartsOption as unknown,
    }));
    await docRef.set({
      title,
      description: description ?? null,
      charts: chartSpecs,
      createdBy: ctx.userId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      content: { ok: true, dashboardId: docRef.id, title, chartCount: charts.length },
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
