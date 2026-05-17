import { z } from "zod";
import type { ToolDefinition } from "./types";

/**
 * Narrow subset of ECharts option that the agent is allowed to emit. Full
 * ECharts API has hundreds of keys — we whitelist the common chart-building
 * subset so the agent can't accidentally crash the browser with a 10MB blob.
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
  legend: z
    .object({
      data: z.array(z.string()).optional(),
      bottom: z.union([z.number(), z.string()]).optional(),
    })
    .optional(),
  grid: z
    .object({
      left: z.union([z.string(), z.number()]).optional(),
      right: z.union([z.string(), z.number()]).optional(),
      top: z.union([z.string(), z.number()]).optional(),
      bottom: z.union([z.string(), z.number()]).optional(),
      containLabel: z.boolean().optional(),
    })
    .optional(),
  xAxis: z.union([AxisSchema, z.array(AxisSchema)]).optional(),
  yAxis: z.union([AxisSchema, z.array(AxisSchema)]).optional(),
  series: z.array(SeriesSchema).min(1).max(8),
});

const Input = z.object({
  title: z.string().min(1).max(120).describe("Short, descriptive chart title."),
  echartsOption: EChartsOption.describe(
    "ECharts option object. Must be a valid bar/line/pie/scatter/area chart spec."
  ),
});

export const makeChartTool: ToolDefinition = {
  name: "make_chart",
  description:
    "Render a chart inline in the chat. The result is shown to the user immediately. Use this whenever the answer to a question is better understood visually — comparisons, time series, distributions, rankings.",
  inputSchema: Input,
  handler: async (raw) => {
    const { title, echartsOption } = Input.parse(raw);
    return {
      content: { ok: true, title },
      clientRender: { kind: "chart", spec: echartsOption, title },
    };
  },
};
