import { z } from "zod";
import type { ToolDefinition } from "./types";

/**
 * Narrow subset of ECharts option that the agent is allowed to emit. Full
 * ECharts API has hundreds of keys — we whitelist the common chart-building
 * subset so the agent can't accidentally crash the browser with a 10MB blob.
 *
 * No z.union() / no z.unknown() — Gemini's Schema proto doesn't accept
 * JSON-Schema-7's `type: [a,b]` array form, and our zod-to-gemini
 * converter can't resolve $ref. Numeric series, string axis labels,
 * string grid offsets ("10%" / "auto" / "10"). Single-axis only.
 */
const SeriesSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["bar", "line", "pie", "scatter", "area"]),
  data: z.array(z.number()).max(10_000),
  smooth: z.boolean().optional(),
  stack: z.string().optional(),
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
  title: z.string().min(1).max(120).describe("Short, descriptive chart title."),
  echartsOption: EChartsOption.describe(
    "ECharts option object. Must be a valid bar/line/pie/scatter/area chart spec."
  ),
});

/**
 * ECharts field names the model sometimes puts at the TOP level of the
 * tool input instead of inside `echartsOption`. Defensive normalization
 * moves them into `echartsOption` so a common shape mistake doesn't
 * cost a round-trip + correction turn. The system prompt also tells
 * the model the correct shape; this is belt-and-braces.
 *
 * Observed failure pattern: model emits
 *   { title, yAxis, series, echartsOption: { xAxis } }
 * Should be:
 *   { title, echartsOption: { xAxis, yAxis, series } }
 */
const ECHARTS_TOP_LEVEL_KEYS = [
  "series",
  "xAxis",
  "yAxis",
  "tooltip",
  "legend",
  "grid",
] as const;

function normalizeChartInput(raw: unknown): unknown {
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
    r.echartsOption = existing;
    console.warn(
      "[make_chart] normalised top-level ECharts keys into echartsOption — model misplaced fields"
    );
  } else {
    r.echartsOption = existing;
  }
  return r;
}

export const makeChartTool: ToolDefinition = {
  name: "make_chart",
  description:
    "Render a chart inline in the chat. The result is shown to the user immediately. Use this whenever the answer to a question is better understood visually — comparisons, time series, distributions, rankings.",
  inputSchema: Input,
  handler: async (raw) => {
    const { title, echartsOption } = Input.parse(normalizeChartInput(raw));
    return {
      content: { ok: true, title },
      clientRender: { kind: "chart", spec: echartsOption, title },
    };
  },
};
