import { z } from "zod";
import { runRecommendations } from "@/lib/bqml";
import { getWorkspaceRegional } from "@/lib/workspace-settings-server";
import type { ToolDefinition } from "./types";

const Input = z.object({
  source_sql: z
    .string()
    .min(1)
    .describe(
      "A read-only BigQuery SELECT producing ONE ROW PER (basket, item) — e.g. order line items or per-customer purchases. Exactly two columns matter: the basket key and the item. Fully-qualify tables as `dataset.table` (from list_tables). Example: SELECT order_id, product_name FROM `ds.order_items`. For 'customers who bought X also bought Y', use the customer id as the basket: SELECT customer_id, product_id FROM `ds.purchases`."
    ),
  group_column: z
    .string()
    .min(1)
    .describe(
      "The basket key column — what groups items together. Use an ORDER id for 'frequently bought together in one order', or a CUSTOMER id for 'bought by the same customer'. Co-occurrence is counted within this group."
    ),
  item_column: z
    .string()
    .min(1)
    .describe("The item identifier column to recommend on (e.g. 'product_name', 'sku')."),
  target_item: z
    .string()
    .optional()
    .describe(
      "Optional: focus recommendations on items associated with this ONE item (e.g. 'Espresso Machine' → what's bought alongside it). Compared as text against item_column values. Omit to get the top item pairs across the whole catalogue."
    ),
  min_support: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Ignore pairs seen in fewer than this many baskets — the noise floor. Default 5. Raise it for big catalogues, lower it for sparse data."
    ),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("How many recommendations / pairs to return. Default 50."),
});

export const recommendTool: ToolDefinition = {
  name: "run_recommendations",
  description:
    "Find which items are bought together and recommend complementary products, using in-warehouse market-basket analysis (item-item co-occurrence). Use this for 'frequently bought together', 'customers who bought X also bought Y', 'what should we cross-sell with this product', or 'find product affinities'. You give it transaction rows (a basket key + an item); it returns the strongest item pairs ranked by lift (how much more often they co-occur than chance), with co-occurrence counts and confidence. Pass target_item to focus on one product's best companions. Runs as plain read-only aggregation — cheap, no model training, shares the same cost guard as the other tools.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const p = Input.parse(raw);
    const regional = await getWorkspaceRegional(ctx.clientId, ctx.workspaceId);

    const result = await runRecommendations({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      sourceSql: p.source_sql,
      groupColumn: p.group_column,
      itemColumn: p.item_column,
      targetItem: p.target_item,
      minSupport: p.min_support,
      topN: p.top_n,
      location: regional.bqLocation,
    });

    const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

    const content: Record<string, unknown> = {
      baskets_analyzed: result.basketsAnalyzed,
      lift_note:
        "Lift > 1 means the items are bought together more than chance predicts (a real affinity); ~1 means independent; < 1 means rarely together. Confidence is the share of one item's baskets that also contain the other. Lead with lift, use co_count to gauge how much evidence backs it.",
    };

    let clientRows: unknown[];

    if (result.recommendations) {
      content.target_item = result.target;
      content.recommendations = result.recommendations.map((r) => ({
        item: r.item,
        co_count: r.coCount,
        confidence: round(r.confidence),
        lift: round(r.lift),
      }));
      if (result.recommendations.length === 0) {
        content.empty_note =
          "No co-occurring items cleared the support floor. Lower min_support, widen source_sql's date range, or check the target_item value matches the data exactly.";
      }
      clientRows = (content.recommendations as unknown[]) ?? [];
    } else {
      const pairs = (result.pairs ?? []).map((pr) => ({
        item_a: pr.itemA,
        item_b: pr.itemB,
        co_count: pr.coCount,
        confidence_a_to_b: round(pr.confidenceAtoB),
        confidence_b_to_a: round(pr.confidenceBtoA),
        lift: round(pr.lift),
      }));
      content.pairs = pairs;
      if (pairs.length === 0) {
        content.empty_note =
          "No item pairs cleared the support floor. Lower min_support or widen source_sql's date range.";
      }
      clientRows = pairs;
    }

    return {
      content,
      clientRender: { kind: "table" as const, rows: clientRows },
    };
  },
};
