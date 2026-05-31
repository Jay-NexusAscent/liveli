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
  type: z.enum(["bar", "line", "pie", "donut", "scatter", "area", "kpi"]),
  data: z.array(z.number()).max(10_000),
  smooth: z.boolean().optional(),
  stack: z.string().optional(),
  /**
   * Value-format hints. `format` and `unit` apply to EVERY chart type:
   * on a KPI tile they format the single big number; on a bar / line /
   * area / scatter chart they format the value-axis ticks AND the
   * tooltip, so a revenue chart shows "£1.2M" on the axis instead of a
   * bare "1200000". Set them whenever the values aren't plain counts:
   *   format="currency" → money (uses the workspace currency unless a
   *                       per-series `currency` override is given)
   *   format="percent"  → rates / shares (0.03 and 3 both render "3.0%")
   *   format="number"   → counts with a `unit` suffix (e.g. "kg", "ms")
   * Leave `format` UNSET for plain integer axes (years, raw counts) so
   * they render untouched.
   *   delta:      KPI ONLY — comparison number (positive up, negative down)
   *   deltaLabel: KPI ONLY — caption for the delta ("vs last month")
   */
  format: z.enum(["number", "currency", "percent"]).optional(),
  unit: z.string().max(8).optional(),
  delta: z.number().optional(),
  deltaLabel: z.string().max(40).optional(),
  /**
   * Per-series currency override (ISO 4217 — "USD", "EUR", "JPY",
   * etc.). Optional. The chart renderer falls back to the workspace
   * currency setting when this is omitted.
   *
   * Only set this when the source data is in a currency OTHER than
   * the workspace default — e.g. a Stripe connector that reports USD
   * charges in a workspace whose primary currency is GBP. Leave it
   * unset for everything else; the agent never needs to repeat the
   * workspace currency, and a wrong override is harder to spot than
   * a missing one.
   */
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
      "Axis title, e.g. \"Date\" or \"Revenue (£)\". Set on BOTH axes for bar/line/area/scatter charts — it renders as the axis label. Keep it short (2-4 words). Skip for KPI/pie/donut (no axes)."
    ),
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
    "Render a chart inline in the chat. The result is shown to the user immediately. Use this whenever the answer to a question is better understood visually — comparisons, time series, distributions, rankings. " +
    "Name both axes (`xAxis.name` / `yAxis.name`), and set `series[].format` (\"currency\" / \"percent\" / \"number\") on money/rate/unit charts so the value axis and tooltips render the right symbols — not just on KPI tiles. " +
    "Per-series `currency` (ISO 4217) is optional: only set it when the source data is in a different currency than the workspace default — e.g. a Stripe connector reporting USD when the workspace currency is GBP. Leave it unset otherwise; the renderer uses the workspace currency by default.",
  inputSchema: Input,
  handler: async (raw) => {
    const { title, echartsOption } = Input.parse(normalizeChartInput(raw));
    return {
      content: { ok: true, title },
      clientRender: { kind: "chart", spec: echartsOption, title },
    };
  },
};
