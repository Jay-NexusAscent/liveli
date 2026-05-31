import { z } from "zod";
import { safeQuery } from "@/lib/bigquery";
import type { ToolDefinition } from "./types";

const Input = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      "BigQuery Standard SQL. Tables MUST be fully qualified as `dataset.table` — call list_tables first to discover the dataset name for each connector. Read-only — SELECTs only."
    ),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Cap rows returned to the model. Default 100."),
});

/**
 * Defense-in-depth read-only check.
 *
 * The real safety boundary is the workspace SA's IAM — it has
 * `bigquery.dataViewer` only on workspace datasets, so even a smuggled
 * DELETE would fail at the BQ permission layer. But customer-facing
 * model output reaching the SQL planner deserves a syntactic guard
 * too. The previous version only checked the first keyword, which
 * misses:
 *   - Multi-statement scripts: "SELECT 1 ; DELETE FROM x"
 *   - Block-comment injection: a /-star-...-star-/ before a DELETE
 *   - Line comments: "-- foo\nDELETE FROM x"
 *
 * This version normalises (strip comments, collapse whitespace),
 * splits on `;`, and requires every non-empty statement to start with
 * SELECT or WITH. Still not a full SQL parser — adversarial SQL could
 * still slip through clever quoting — but the IAM layer remains the
 * actual boundary.
 */
function isReadOnlySql(sql: string): boolean {
  // Strip block comments  /* ... */
  let cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Strip line comments  -- ... \n
  cleaned = cleaned.replace(/--[^\n]*/g, " ");
  // Split on `;`, trim, drop empties
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) return false;
  return statements.every((s) => /^(SELECT|WITH)\b/i.test(s));
}

function stripSyncMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_sdc_")) continue;
    out[k] = v;
  }
  return out;
}

export const runSqlTool: ToolDefinition = {
  name: "run_sql",
  description:
    "Execute a read-only SQL query against the user's workspace warehouse and return the result rows. Tables are spread across one dataset per connector — fully-qualify them with `dataset.table` (which you get from list_tables). Safety: queries are dry-run first; anything over 10 GB scan is rejected.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { sql, maxRows = 100 } = Input.parse(raw);
    // `{{ … }}` is a dashboard FILTER PLACEHOLDER, not SQL. BigQuery parses
    // a leading `{{` as a braced struct constructor and fails with an
    // opaque "Invalid braced constructor" error. Catch it here with an
    // actionable message: run_sql is for exploration with LITERAL values;
    // placeholders only belong in a chart's `sourceSql` passed to
    // make_dashboard. The model gets a clear correction signal instead of
    // a BigQuery syntax error it can't easily map back to its mistake.
    if (/\{\{/.test(sql)) {
      throw new Error(
        "run_sql does not accept {{filter:...}} placeholders — those are only for a chart's sourceSql in make_dashboard. " +
          "To explore, substitute concrete literal values (e.g. a real date range like TIMESTAMP(\"2026-05-01\")) and run that. " +
          "Keep the {{...}} version for the chart's sourceSql so the dashboard can re-render it under filter changes."
      );
    }
    if (!isReadOnlySql(sql)) {
      throw new Error("Only SELECT and WITH queries are allowed (no DDL/DML, no multi-statement scripts).");
    }
    const result = await safeQuery(sql, {
      maxRows,
      context: {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      },
    });
    // Strip Singer/Meltano sync-metadata columns (_sdc_extracted_at,
    // _sdc_batched_at, etc.). They're an artifact of the ingestion
    // pipeline and not part of the user's actual data — surfacing them
    // both pollutes the chat UI's table render and tempts the model
    // to comment on or chart them.
    const rows = result.rows.map(stripSyncMetadata);
    // Single-value result (1 row × 1 column) — let the model's prose
    // carry the answer. A table for one number is noise. The model
    // still receives the value via `content.rows` for its reply.
    const isSingleValue =
      rows.length === 1 && rows[0] && Object.keys(rows[0]).length === 1;
    return {
      content: {
        rows,
        rowCount: result.rowCount,
        bytesScanned: result.bytesScanned,
        truncated: result.truncated,
      },
      ...(isSingleValue ? {} : { clientRender: { kind: "table" as const, rows } }),
    };
  },
};
