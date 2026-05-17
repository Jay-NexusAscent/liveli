import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { dashboards } from "@/lib/firestore";
import type { ToolDefinition } from "./types";

/**
 * Reuse the same narrow ECharts spec subset as make_chart.
 */
const SeriesSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["bar", "line", "pie", "scatter", "area"]),
  data: z.array(z.unknown()).max(10_000),
  smooth: z.boolean().optional(),
  stack: z.string().optional(),
});

const AxisSchema = z.object({
  type: z.enum(["category", "value", "time", "log"]),
  data: z.array(z.union([z.string(), z.number()])).max(10_000).optional(),
  name: z.string().optional(),
});

const EChartsOption = z.object({
  title: z.object({ text: z.string(), subtext: z.string().optional() }).optional(),
  tooltip: z.object({ trigger: z.enum(["axis", "item", "none"]).optional() }).optional(),
  legend: z.object({ data: z.array(z.string()).optional() }).optional(),
  xAxis: z.union([AxisSchema, z.array(AxisSchema)]).optional(),
  yAxis: z.union([AxisSchema, z.array(AxisSchema)]).optional(),
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

export const makeDashboardTool: ToolDefinition = {
  name: "make_dashboard",
  description:
    "Create a dashboard composed of multiple charts in one call. Use this when the user asks for an overview, summary, or report covering several related metrics. The dashboard is saved immediately and visible on the Dashboards tab.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { title, description, charts } = Input.parse(raw);
    const docRef = dashboards(ctx.orgId).doc();
    await docRef.set({
      title,
      description: description ?? null,
      charts: charts.map((c, i) => ({
        order: i,
        title: c.title,
        spec: c.echartsOption,
      })),
      createdBy: ctx.userId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      content: { ok: true, dashboardId: docRef.id, title, chartCount: charts.length },
      clientRender: { kind: "chart", spec: { title, dashboardId: docRef.id }, title },
    };
  },
};
