import { z } from "zod";
import { runAnomalyDetection } from "@/lib/bqml";
import { getWorkspaceRegional } from "@/lib/workspace-settings-server";
import type { ToolDefinition } from "./types";

const Input = z.object({
  source_sql: z
    .string()
    .min(1)
    .describe(
      "A read-only BigQuery SELECT that produces the time series to scan for anomalies. It MUST return exactly: one time column (DATE/TIMESTAMP), one numeric value column, and optionally one series column. AGGREGATE to a regular grain — GROUP BY a day/week/month bucket of the timestamp. Fully-qualify tables as `dataset.table` (from list_tables). Example: SELECT DATE(created_at) AS day, COUNT(*) AS orders FROM `ds.orders` GROUP BY day."
    ),
  time_column: z
    .string()
    .min(1)
    .describe("Name of the time column in source_sql (e.g. 'day'). DATE or TIMESTAMP."),
  value_column: z
    .string()
    .min(1)
    .describe("Name of the numeric measure column in source_sql (e.g. 'orders')."),
  series_column: z
    .string()
    .optional()
    .describe(
      "Optional: name of a column that splits the data into multiple independent series to scan at once (e.g. 'product', 'region'). Omit for a single overall series."
    ),
  data_frequency: z
    .enum(["AUTO", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"])
    .optional()
    .describe("Grain of the series. Default AUTO lets BigQuery infer it."),
  sensitivity: z
    .number()
    .min(0.5)
    .max(0.99)
    .optional()
    .describe(
      "Anomaly probability threshold (0.5–0.99). A point is flagged when the model's probability that it's anomalous exceeds this. Higher = stricter (fewer, more confident flags). Default 0.95."
    ),
});

export const detectAnomaliesTool: ToolDefinition = {
  name: "detect_anomalies",
  description:
    "Find unusual points in a metric's history using in-warehouse time-series modelling (BigQuery ML ARIMA_PLUS). Use this for 'which days were abnormal', 'spot anomalies in orders', 'did anything spike or dip unexpectedly'. It learns the metric's normal trend + seasonality, then flags points that fall outside the expected range. Returns a table of flagged points with the value, the expected range, and how confident the model is. Shares a model with forecast over the same series, so it's near-free after the first run.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const p = Input.parse(raw);
    const regional = await getWorkspaceRegional(ctx.clientId, ctx.workspaceId);

    const result = await runAnomalyDetection({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      sourceSql: p.source_sql,
      timeColumn: p.time_column,
      valueColumn: p.value_column,
      seriesColumn: p.series_column,
      dataFrequency: p.data_frequency,
      anomalyProbThreshold: p.sensitivity,
      location: regional.bqLocation,
      holidayRegion: regional.holidayRegion,
    });

    const thresholdPct = Math.round((p.sensitivity ?? 0.95) * 100);

    const rows = result.anomalies.map((a) => ({
      ...(a.series !== undefined ? { series: a.series } : {}),
      date: a.ts,
      value: a.value,
      expected_low: a.lower,
      expected_high: a.upper,
      confidence: Math.round(a.probability * 100) / 100,
    }));

    return {
      content: {
        trained: result.trained,
        points_evaluated: result.pointsEvaluated,
        anomalies_found: result.anomalies.length,
        threshold_note: `Flagged points exceed a ${thresholdPct}% anomaly probability — i.e. they fall outside the model's expected range for the metric's trend and seasonality.`,
        // Cap the inline list so a noisy series doesn't blow the token
        // budget; the full set renders in the client table below.
        anomalies: rows.slice(0, 50),
      },
      clientRender: { kind: "table", rows },
    };
  },
};
