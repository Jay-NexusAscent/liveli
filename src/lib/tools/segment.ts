import { z } from "zod";
import { runClustering } from "@/lib/bqml";
import { getWorkspaceRegional } from "@/lib/workspace-settings-server";
import type { ToolDefinition } from "./types";

const Input = z.object({
  source_sql: z
    .string()
    .min(1)
    .describe(
      "A read-only BigQuery SELECT producing the entities to segment: one row per entity (e.g. a customer), with the FEATURE columns to group on (numeric or categorical — e.g. spend, recency, frequency). Optionally include one ID column to label rows in the assignment readout. Fully-qualify tables as `dataset.table` (from list_tables). Pre-aggregate to one row per entity. Example: SELECT customer_id, SUM(amount) AS total_spend, COUNT(*) AS orders, DATE_DIFF(CURRENT_DATE(), MAX(order_date), DAY) AS recency_days FROM `ds.orders` GROUP BY customer_id."
    ),
  id_column: z
    .string()
    .optional()
    .describe(
      "Optional: name of an entity-id column (e.g. 'customer_id'). It is excluded from the clustering features and used to label which segment each entity landed in."
    ),
  num_clusters: z
    .number()
    .int()
    .min(2)
    .max(20)
    .optional()
    .describe(
      "How many segments to form. Omit to let BigQuery choose automatically. Typical retail RFM segmentation uses 3–6."
    ),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "How many entity→segment assignments to sample back (requires id_column). Default 200."
    ),
});

export const segmentTool: ToolDefinition = {
  name: "run_segmentation",
  description:
    "Group entities into natural segments and describe what makes each one distinct, using in-warehouse modelling (BigQuery ML KMEANS). Use this for 'segment our customers', 'find natural groupings', 'build RFM/persona segments', or 'cluster products by behaviour'. You give it one row per entity with the attributes to group on; it returns each segment's size and centroid profile (the typical feature values that define it) and — if you pass an id column — a sample of which entity landed in which segment. Features are standardized automatically, so columns on different scales mix safely. Shares the cached-model + cost-guard machinery with forecast/classification, so repeat asks are cheap.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const p = Input.parse(raw);
    const regional = await getWorkspaceRegional(ctx.clientId, ctx.workspaceId);

    const result = await runClustering({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      sourceSql: p.source_sql,
      idColumn: p.id_column,
      numClusters: p.num_clusters,
      topN: p.top_n,
      location: regional.bqLocation,
    });

    const round = (n: number) =>
      typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n;

    const roundFeatures = (features: Record<string, number | string>) =>
      Object.fromEntries(
        Object.entries(features).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])
      );

    const segments = result.profiles.map((p) => ({
      segment: p.cluster,
      size: p.size,
      profile: roundFeatures(p.features),
    }));

    const content: Record<string, unknown> = {
      trained: result.trained,
      num_segments: result.numClusters,
      segments,
      profile_note:
        "Each segment's profile is its centroid — the typical feature values for members. Numeric values are the (standardized-then-restored) means; categorical values are the dominant category. Compare segments across the same feature to name them (e.g. high spend + low recency = 'champions').",
    };

    if (result.assignments) {
      content.assigned_sample = result.assignments.length;
    } else {
      content.assignment_note =
        "No per-entity assignments returned. To get a list of which entity is in which segment, call again with id_column set.";
    }

    // Prefer the entity→segment assignments for the client table; fall back to
    // the segment profiles when no id_column was supplied.
    const clientRender = result.assignments
      ? {
          kind: "table" as const,
          rows: result.assignments.map((a) => ({
            id: a.id,
            segment: a.cluster,
            distance: round(a.distance),
          })),
        }
      : {
          kind: "table" as const,
          rows: segments.map((s) => ({ segment: s.segment, size: s.size, ...s.profile })),
        };

    return { content, clientRender };
  },
};
