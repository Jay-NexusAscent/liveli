import { z } from "zod";
import type { ToolDefinition } from "./types";
import type { InsightProposal } from "@/lib/streaming";

/**
 * Single proposal shape — mirrors save_insight input. The agent emits
 * a batch of these; each becomes a card in chat with its own Save
 * button. Gemini-flat (no z.union) per the existing tool pattern.
 *
 * Why the same shape as save_insight: when the user clicks Save on a
 * card, the UI POSTs this object straight to /api/insights, no
 * remapping. Adding fields to one means adding them to both — kept in
 * sync via a comment in save-insight.ts.
 */
const ProposalSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(400),
  category: z.enum(["Sales", "Customer", "Operational", "Growth"]),
  sourceSql: z.string().min(1),
  sourceConnector: z.string().max(80).optional(),
  ruleType: z.enum([
    "change_pct_above",
    "change_pct_below",
    "value_above",
    "value_below",
  ]),
  threshold: z.number(),
  prefill: z.string().min(1).max(400),
});

const Input = z.object({
  proposals: z
    .array(ProposalSchema)
    .min(1)
    .max(8)
    .describe(
      "1-8 proposed insights for the user to pick from. Each must be plausibly useful and grounded in tables the user actually has — don't propose generic metrics that don't exist in their schema."
    ),
});

export const proposeInsightsTool: ToolDefinition = {
  name: "propose_insights",
  description:
    "Propose 3-5 insight ideas as inline cards in chat. The user picks which to save. Does NOT run SQL or persist anything — the SQL is verified when the user clicks Save on a card. Use this when the user asks you to SUGGEST or RECOMMEND insights. For direct 'track this' requests use `save_insight` immediately instead.",
  inputSchema: Input,
  handler: async (raw) => {
    const { proposals } = Input.parse(raw);
    // No SQL execution, no Firestore write — proposals stay in chat
    // until acceptance. Validating SQL here would run 3-5 BigQuery
    // jobs per suggest call regardless of how many the user actually
    // wants; we'd rather pay BQ cost only on accepted proposals.
    return {
      content: {
        ok: true,
        proposalCount: proposals.length,
      },
      clientRender: {
        kind: "insight-proposals",
        proposals: proposals as InsightProposal[],
      },
    };
  },
};
