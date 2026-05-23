import { z } from "zod";
import { getTableSchema } from "@/lib/bigquery";
import type { ToolDefinition } from "./types";

const Input = z.object({
  dataset: z
    .string()
    .min(1)
    .describe(
      "Fully qualified dataset name (e.g. `c_<id>__w_<id>__d_<connectorId>`). Get this from list_tables — every table entry there carries a `dataset` field."
    ),
  table: z
    .string()
    .min(1)
    .describe(
      "Table name within the dataset (e.g. `public_orders`). Get this from list_tables's `table` field."
    ),
});

/**
 * Deep-dive metadata tool. `list_tables` returns lightweight summaries
 * (dataset + table + rowCount + column name/type only). When the agent
 * needs column-level semantic descriptions — to disambiguate similar
 * column names, understand nullability, decide which column is the
 * canonical "placed at" timestamp etc. — it calls describe_table.
 *
 * Splitting like this keeps every list_tables call cheap (workspaces
 * with 8 connectors × 10 tables × 20 columns produced ~160KB of
 * description-only noise before this split). Agent drills in only on
 * the tables it actually intends to query.
 *
 * Validation lives in `getTableSchema` — the dataset path is checked
 * against the workspace prefix, so the agent can't smuggle a foreign
 * dataset.
 */
export const describeTableTool: ToolDefinition = {
  name: "describe_table",
  description:
    "Get full column-level metadata (names, types, semantic descriptions, nullability) for a specific table. Call this when you need to choose between similarly-named columns (e.g. created_at vs placed_at vs shipped_at) or when a table is unfamiliar. For schema overview across all tables, use list_tables instead — this is the deeper lookup. Inputs: `dataset` and `table` from a prior list_tables response.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { dataset, table } = Input.parse(raw);
    const schema = await getTableSchema(ctx.clientId, ctx.workspaceId, dataset, table);
    return {
      content: schema,
    };
  },
};
