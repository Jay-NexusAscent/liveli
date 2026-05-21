import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { dashboardsIn } from "@/lib/firestore";
import type { ToolDefinition } from "./types";

// Schemas mirror make-dashboard.ts. Inline (not imported) for the same
// Gemini function-declaration robustness reasons.
const SeriesSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["bar", "line", "pie", "donut", "scatter", "area", "kpi"]),
  data: z.array(z.number()).max(10_000),
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

const ChartSpec = z.object({
  title: z.string().min(1).max(120),
  echartsOption: EChartsOption,
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

export const updateDashboardTool: ToolDefinition = {
  name: "update_dashboard",
  description:
    "Update an EXISTING dashboard's title, description, and FULL chart list. Use when the user is editing a dashboard and asks for changes — the `dashboardId` comes from the edit context. The `charts` field REPLACES the existing list entirely, so include every chart that should be on the dashboard after the edit (not just the changed ones). Do NOT use to create a new dashboard — use `make_dashboard` for that.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { dashboardId, title, description, charts } = Input.parse(normalizeInput(raw));
    const ref = dashboardsIn(ctx.clientId, ctx.workspaceId).doc(dashboardId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(
        `Dashboard ${dashboardId} not found in this workspace — it may have been deleted. Cannot update.`
      );
    }
    const chartSpecs = charts.map((c, i) => ({
      order: i,
      title: c.title,
      spec: c.echartsOption as unknown,
    }));
    await ref.update({
      title,
      description: description ?? null,
      charts: chartSpecs,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      content: { ok: true, dashboardId, title, chartCount: charts.length },
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
