import { z } from "zod";
import { listWorkspaceTables } from "@/lib/bigquery";
import { connectorsIn, dbReady } from "@/lib/firestore";
import type { ToolDefinition } from "./types";

const Input = z.object({});

/**
 * Filter rule: when a dataset contains ANY dbt-curated table (prefix
 * `fct_` or `dim_`), hide the raw + staging tables so the agent only
 * sees the curated layer. When a dataset has NO curated tables (i.e.
 * a connector type with no dbt models defined yet, or a customer DB
 * source like Postgres/MySQL), surface everything — raw IS the only
 * layer there, no point hiding it.
 *
 * Staging models (`stg_` prefix) are NEVER surfaced to the agent.
 * They're intermediate scratchpads for downstream fct/dim transforms;
 * the agent should never query them directly.
 *
 * Why: pre-curated facts + dimensions have clean column names, derived
 * metrics, and appropriate types. The agent produces dramatically
 * better SQL when steered to them. Raw tables (with their nested JSON
 * + camelCase columns + source-specific quirks) are a fallback for
 * questions the curated layer doesn't cover — but for any connector
 * we've shipped dbt models for, that's a vanishingly small fraction.
 *
 * To bypass the filter (e.g. customer specifically asks about a raw
 * table), the agent can call `describe_table` directly with the
 * fully-qualified raw table name — `describe_table` doesn't filter.
 */
function filterToCuratedWherePresent<T extends { dataset: string; table: string }>(
  tables: T[]
): T[] {
  // Group by dataset for the per-dataset has-curated check.
  const byDataset = new Map<string, T[]>();
  for (const t of tables) {
    const arr = byDataset.get(t.dataset) ?? [];
    arr.push(t);
    byDataset.set(t.dataset, arr);
  }

  const out: T[] = [];
  for (const [, datasetTables] of byDataset) {
    const hasCurated = datasetTables.some(
      (t) => t.table.startsWith("fct_") || t.table.startsWith("dim_")
    );
    if (hasCurated) {
      // Dataset has dbt models — surface only fct_/dim_, hide raw + stg_.
      for (const t of datasetTables) {
        if (t.table.startsWith("fct_") || t.table.startsWith("dim_")) {
          out.push(t);
        }
      }
    } else {
      // No curation for this dataset — surface everything raw.
      // Also drop any orphan stg_ tables (shouldn't exist without
      // fct/dim siblings, but defensive).
      for (const t of datasetTables) {
        if (!t.table.startsWith("stg_")) out.push(t);
      }
    }
  }
  return out;
}

/**
 * Returns every table the user's connectors have synced, grouped by
 * connector (the agent gets a `dataset` per connector + the table name
 * inside it). The agent SHOULD use the fully-qualified `dataset.table`
 * form in any SQL it then writes — there is no shared default dataset
 * in the new model.
 *
 * Curated-tables filter applied (see filterToCuratedWherePresent
 * above): for any connector with dbt models materialised, only the
 * curated `fct_*` / `dim_*` tables are surfaced. Raw tables stay
 * fully queryable via `describe_table` for the rare case the customer
 * explicitly needs them.
 */
export const listTablesTool: ToolDefinition = {
  name: "list_tables",
  description:
    "List every table available across all of the user's connected data sources, including row counts and column types. Each connector has its own BigQuery dataset; the response groups tables by connector and provides the dataset name. For connectors with curated tables (prefixed fct_ for facts, dim_ for dimensions), only the curated layer is shown — these are pre-cleaned, agent-friendly views over the raw source data. Always call this first when the user asks an open-ended question. When you then write SQL, fully qualify table names as `dataset.table`.",
  inputSchema: Input,
  handler: async (_raw, ctx) => {
    await dbReady();
    const snap = await connectorsIn(ctx.clientId, ctx.workspaceId).get();
    const connectorRefs = snap.docs.map((d) => {
      const data = d.data() as { name?: string; type?: string };
      return { id: d.id, name: data.name, type: data.type };
    });

    const allTables = await listWorkspaceTables(
      ctx.clientId,
      ctx.workspaceId,
      connectorRefs
    );

    const tables = filterToCuratedWherePresent(allTables);

    return { content: { tables } };
  },
};
