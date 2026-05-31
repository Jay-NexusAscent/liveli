import { z } from "zod";
import { runClassification } from "@/lib/bqml";
import { getWorkspaceRegional } from "@/lib/workspace-settings-server";
import type { ToolDefinition } from "./types";

const Input = z.object({
  source_sql: z
    .string()
    .min(1)
    .describe(
      "A read-only BigQuery SELECT producing the training set: one row per entity (e.g. a customer), several FEATURE columns (numeric or categorical), and exactly one binary LABEL column with two distinct values (e.g. 'churned'/'active' or 1/0). Optionally include one ID column to rank entities later. Fully-qualify tables as `dataset.table` (from list_tables). Example: SELECT customer_id, total_spend, orders, days_since_last_order, IF(cancelled_at IS NULL, 'active', 'churned') AS churn_label FROM `ds.customers`."
    ),
  label_column: z
    .string()
    .min(1)
    .describe(
      "Name of the binary label column in source_sql (e.g. 'churn_label'). Must have exactly two distinct values."
    ),
  id_column: z
    .string()
    .optional()
    .describe(
      "Optional: name of an entity-id column (e.g. 'customer_id'). It is excluded from the model's features and used to rank entities by predicted risk. Required (with positive_label) to get a ranked list back."
    ),
  positive_label: z
    .string()
    .optional()
    .describe(
      "Which label value is the event of interest (e.g. 'churned', 'true', '1'). Required (with id_column) to rank entities by the probability of THIS class. Compared as text."
    ),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("How many top-ranked entities to return when scoring. Default 100."),
});

const ACCURACY_NOTE =
  "ROC AUC reads as: 0.5 = no better than chance, 0.7+ = useful, 0.8+ = strong, 0.9+ = excellent. Always tell the user the AUC so they know how much to trust the prediction.";

export const classifyTool: ToolDefinition = {
  name: "run_binary_classification",
  description:
    "Predict a yes/no outcome and explain what drives it, using in-warehouse modelling (BigQuery ML LOGISTIC_REG). Use this for 'who is likely to churn', 'which leads will convert', 'flag risky orders', or 'what factors drive cancellations'. You give it a labelled training set (features + a binary label); it returns model quality (ROC AUC, accuracy, precision, recall), the ranked feature drivers (which inputs push the outcome each way), and — if you pass an id column + positive_label — a ranked list of the highest-probability entities. Shares the cached-model + cost-guard machinery with forecast, so repeat asks are cheap.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const p = Input.parse(raw);
    const regional = await getWorkspaceRegional(ctx.clientId, ctx.workspaceId);

    const result = await runClassification({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      sourceSql: p.source_sql,
      labelColumn: p.label_column,
      idColumn: p.id_column,
      positiveLabel: p.positive_label,
      topN: p.top_n,
      location: regional.bqLocation,
    });

    const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

    const drivers = result.weights.map((w) => ({
      feature: w.feature,
      direction: w.weight >= 0 ? "increases" : "decreases",
      influence: round(Math.abs(w.weight)),
    }));

    const content: Record<string, unknown> = {
      trained: result.trained,
      model_quality: {
        roc_auc: round(result.metrics.rocAuc),
        accuracy: round(result.metrics.accuracy),
        precision: round(result.metrics.precision),
        recall: round(result.metrics.recall),
        f1: round(result.metrics.f1),
        log_loss: round(result.metrics.logLoss),
      },
      quality_note: ACCURACY_NOTE,
      // Cap the inline driver list; full set is small but keep it tidy.
      top_drivers: drivers.slice(0, 15),
    };

    if (result.topRisk) {
      content.scored_entities = result.topRisk.length;
      content.top_risk = result.topRisk.slice(0, 25);
    } else {
      content.scoring_note =
        "No ranked entities returned. To get a list of the highest-probability entities, call again with both id_column (what to rank) and positive_label (which class to rank on).";
    }

    // Prefer the actionable ranked list for the client table; fall back to the
    // driver weights when scoring wasn't requested.
    const clientRender = result.topRisk
      ? {
          kind: "table" as const,
          rows: result.topRisk.map((e) => ({
            id: e.id,
            predicted: e.predictedLabel,
            probability: round(e.probability),
          })),
        }
      : { kind: "table" as const, rows: drivers };

    return { content, clientRender };
  },
};
