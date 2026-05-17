import { z } from "zod";
import { safeQuery } from "@/lib/bigquery";
import type { ToolDefinition } from "./types";

const Input = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      "BigQuery Standard SQL. Tables are unqualified (the workspace dataset is the default). Read-only — SELECTs only."
    ),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Cap rows returned to the model. Default 100."),
});

const READ_ONLY = /^\s*(SELECT|WITH)\b/i;

export const runSqlTool: ToolDefinition = {
  name: "run_sql",
  description:
    "Execute a read-only SQL query against the user's workspace warehouse and return the result rows. Safety: queries are dry-run first; anything over 10 GB scan is rejected.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { sql, maxRows = 100 } = Input.parse(raw);
    if (!READ_ONLY.test(sql)) {
      throw new Error("Only SELECT and WITH queries are allowed.");
    }
    const result = await safeQuery(ctx.orgId, sql, { maxRows });
    return {
      content: {
        rows: result.rows,
        rowCount: result.rowCount,
        bytesScanned: result.bytesScanned,
        truncated: result.truncated,
      },
      clientRender: { kind: "table", rows: result.rows },
    };
  },
};
