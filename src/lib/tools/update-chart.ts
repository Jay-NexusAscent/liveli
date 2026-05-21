import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { chartsIn } from "@/lib/firestore";
import type { ToolDefinition } from "./types";

/**
 * Mirror of make-chart's SeriesSchema. Kept inline (not imported) so
 * the Gemini function-declaration schema stays self-contained per tool
 * — the converter has known fragility around shared schemas / $ref.
 */
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
  legend: z
    .object({
      data: z.array(z.string()).optional(),
      bottom: z.string().optional(),
    })
    .optional(),
  grid: z
    .object({
      left: z.string().optional(),
      right: z.string().optional(),
      top: z.string().optional(),
      bottom: z.string().optional(),
      containLabel: z.boolean().optional(),
    })
    .optional(),
  xAxis: AxisSchema.optional(),
  yAxis: AxisSchema.optional(),
  series: z.array(SeriesSchema).min(1).max(8),
});

const Input = z.object({
  chartId: z
    .string()
    .min(1)
    .describe("ID of the existing chart to update. Use this exact value from the edit context."),
  title: z.string().min(1).max(120).describe("Updated chart title."),
  echartsOption: EChartsOption.describe(
    "Updated ECharts option object — REPLACES the existing chart spec entirely."
  ),
});

/**
 * Same defensive normalization as make-chart.ts — if the model puts
 * ECharts fields at the top level instead of inside echartsOption,
 * move them inside before validating. See make-chart.ts for the
 * observed failure pattern.
 */
const ECHARTS_TOP_LEVEL_KEYS = ["series", "xAxis", "yAxis", "tooltip", "legend", "grid"] as const;

function normalizeInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const existing =
    r.echartsOption && typeof r.echartsOption === "object" && !Array.isArray(r.echartsOption)
      ? { ...(r.echartsOption as Record<string, unknown>) }
      : {};
  let moved = false;
  for (const key of ECHARTS_TOP_LEVEL_KEYS) {
    if (key in r && !(key in existing)) {
      existing[key] = r[key];
      delete r[key];
      moved = true;
    }
  }
  if (moved) {
    console.warn("[update_chart] normalised top-level ECharts keys into echartsOption");
  }
  r.echartsOption = existing;
  return r;
}

export const updateChartTool: ToolDefinition = {
  name: "update_chart",
  description:
    "Update an EXISTING saved chart with a new title and/or spec. Use when the user is editing a chart and asks for changes — the `chartId` comes from the edit context attached to the conversation. Replaces the chart's stored spec entirely; the chart's row on /dashboards refreshes to show the new version. Do NOT use to create a new chart — use `make_chart` for that.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { chartId, title, echartsOption } = Input.parse(normalizeInput(raw));
    const ref = chartsIn(ctx.clientId, ctx.workspaceId).doc(chartId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(
        `Chart ${chartId} not found in this workspace — it may have been deleted. Cannot update.`
      );
    }
    await ref.update({
      title,
      spec: echartsOption,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      content: { ok: true, chartId, title },
      // Render the updated chart inline so the user sees the change
      // immediately. Same shape as make_chart's clientRender.
      clientRender: { kind: "chart", spec: echartsOption, title },
    };
  },
};
