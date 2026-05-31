import { z } from "zod";
import { runForecast, MAX_HORIZON, type ForecastPoint, type ActualPoint } from "@/lib/bqml";
import { getWorkspaceRegional } from "@/lib/workspace-settings-server";
import type { ToolDefinition } from "./types";

const Input = z.object({
  source_sql: z
    .string()
    .min(1)
    .describe(
      "A read-only BigQuery SELECT that produces the time series to forecast. It MUST return exactly: one time column (DATE/TIMESTAMP), one numeric value column, and optionally one series column. AGGREGATE to a regular grain — GROUP BY a day/week/month bucket of the timestamp. Fully-qualify tables as `dataset.table` (from list_tables). Example: SELECT DATE(created_at) AS day, SUM(amount) AS revenue FROM `ds.orders` GROUP BY day."
    ),
  time_column: z
    .string()
    .min(1)
    .describe("Name of the time column in source_sql (e.g. 'day'). DATE or TIMESTAMP."),
  value_column: z
    .string()
    .min(1)
    .describe("Name of the numeric measure column in source_sql (e.g. 'revenue')."),
  series_column: z
    .string()
    .optional()
    .describe(
      "Optional: name of a column that splits the data into multiple independent series to forecast at once (e.g. 'product', 'region'). Omit for a single overall series."
    ),
  horizon: z
    .number()
    .int()
    .min(1)
    .max(MAX_HORIZON)
    .describe("How many periods ahead to forecast (in the data's own grain — days/weeks/months)."),
  data_frequency: z
    .enum(["AUTO", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"])
    .optional()
    .describe("Grain of the series. Default AUTO lets BigQuery infer it."),
  confidence_level: z
    .number()
    .min(0.5)
    .max(0.99)
    .optional()
    .describe("Confidence level for the prediction interval. Default 0.95."),
});

const ACCENT = "#6366F1";
const BAND = "rgba(99,102,241,0.18)";

/** Downsample to at most `max` points, always keeping first and last. */
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

function buildChart(
  title: string,
  historical: ActualPoint[],
  forecast: ForecastPoint[]
): Record<string, unknown> {
  const n = historical.length;
  const x = [...historical.map((h) => h.ts), ...forecast.map((f) => f.ts)];

  const actual = [...historical.map((h) => h.value), ...forecast.map(() => null)];
  const fcLine: (number | null)[] = [
    ...historical.map(() => null),
    ...forecast.map((f) => f.value),
  ];
  // Connect the dashed forecast line to the last actual point.
  if (n > 0 && forecast.length > 0) fcLine[n - 1] = historical[n - 1].value;

  // Confidence band via the stacked-area trick: an invisible baseline at
  // `lower`, then a filled band of height `upper - lower` stacked on top.
  const lower = [...historical.map(() => null), ...forecast.map((f) => f.lower)];
  const band = [
    ...historical.map(() => null),
    ...forecast.map((f) => f.upper - f.lower),
  ];

  return {
    title: { text: title },
    tooltip: { trigger: "axis" },
    legend: { data: ["Actual", "Forecast"], bottom: 0 },
    grid: { left: "3%", right: "4%", bottom: "12%", containLabel: true },
    xAxis: { type: "category", boundaryGap: false, data: x },
    yAxis: { type: "value" },
    series: [
      {
        name: "Actual",
        type: "line",
        data: actual,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2 },
        itemStyle: { color: ACCENT },
      },
      {
        name: "lower",
        type: "line",
        data: lower,
        stack: "confidence",
        lineStyle: { opacity: 0 },
        showSymbol: false,
        silent: true,
      },
      {
        name: "band",
        type: "line",
        data: band,
        stack: "confidence",
        lineStyle: { opacity: 0 },
        areaStyle: { color: BAND },
        showSymbol: false,
        silent: true,
      },
      {
        name: "Forecast",
        type: "line",
        data: fcLine,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, type: "dashed", color: ACCENT },
        itemStyle: { color: ACCENT },
      },
    ],
  };
}

export const forecastTool: ToolDefinition = {
  name: "forecast",
  description:
    "Forecast a metric into the future from its history using in-warehouse time-series modelling (BigQuery ML ARIMA_PLUS). Use this for any question about what will happen next — 'forecast revenue', 'where will signups be next month', 'project orders for the quarter'. It auto-handles trend, weekly/seasonal cycles and holidays. Returns a chart with a confidence band; always tell the user the range, not just the point estimate.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const p = Input.parse(raw);
    const regional = await getWorkspaceRegional(ctx.clientId, ctx.workspaceId);

    const result = await runForecast({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      sourceSql: p.source_sql,
      timeColumn: p.time_column,
      valueColumn: p.value_column,
      seriesColumn: p.series_column,
      horizon: p.horizon,
      dataFrequency: p.data_frequency,
      confidenceLevel: p.confidence_level,
      location: regional.bqLocation,
      holidayRegion: regional.holidayRegion,
    });

    const confidencePct = Math.round((p.confidence_level ?? 0.95) * 100);

    // Multi-series: too many bands to chart legibly — return a table and
    // let the agent narrate. Single series: rich chart with confidence band.
    if (result.seriesCount > 1) {
      const rows = result.forecast.map((f) => ({
        series: f.series,
        date: f.ts,
        forecast: f.value,
        low: f.lower,
        high: f.upper,
      }));
      return {
        content: {
          trained: result.trained,
          series_count: result.seriesCount,
          horizon: p.horizon,
          interval_note: `Ranges are the ${confidencePct}% prediction interval.`,
          forecast_rows: downsample(rows, 60),
        },
        clientRender: { kind: "table", rows },
      };
    }

    const title = `Forecast: ${p.value_column}`;
    const chart = buildChart(title, result.historical, result.forecast);

    const first = result.forecast[0];
    const last = result.forecast[result.forecast.length - 1];
    return {
      content: {
        trained: result.trained,
        horizon: p.horizon,
        points_forecast: result.forecast.length,
        period_start: first?.ts,
        period_end: last?.ts,
        end_value: last?.value,
        end_range: last ? { low: last.lower, high: last.upper } : undefined,
        interval_note: `Range is the ${confidencePct}% prediction interval — the model is ${confidencePct}% confident the actual lands inside it.`,
        // A downsampled trace so the model can describe the shape without
        // paying tokens for hundreds of rows.
        forecast_preview: downsample(
          result.forecast.map((f) => ({
            date: f.ts,
            value: f.value,
            low: f.lower,
            high: f.upper,
          })),
          12
        ),
      },
      clientRender: { kind: "chart", spec: chart, title },
    };
  },
};
