import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { FunctionDeclaration } from "@google-cloud/vertexai";
import { bqReady, safeQuery } from "@/lib/bigquery";
import { findUncoveredMetadata, type UncoveredMetadata } from "./pre-flight";
import {
  writeColumnDescription,
  writeTableDescription,
  type WriteResult,
} from "./writers";
import { scrubSampleRows } from "./pii-scrub";

/**
 * Connector-bound execution context for the metadata agent. The
 * dataset is closed over here — tools never accept it as a model
 * argument — so the LLM has no syntactic way to reach another
 * tenant's data.
 */
export interface MetadataAgentContext {
  clientId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  bqDataset: string;
  bqLocation: string;
}

export interface MetadataToolResult {
  content: unknown;
}

/**
 * Per-run budget guard. The agent can call N tools across a run;
 * once exhausted, every further tool returns a stub asking the agent
 * to call `finish`. Prevents runaway loops eating tokens / BQ
 * scans on a confused agent.
 */
export interface ToolBudget {
  remaining: number;
}

interface MetadataToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (
    rawInput: unknown,
    ctx: MetadataAgentContext,
    budget: ToolBudget,
  ) => Promise<MetadataToolResult>;
}

// ── list_uncovered_columns ───────────────────────────────────────

const ListUncoveredInput = z.object({}).describe("No arguments.");

const listUncoveredTool: MetadataToolDefinition = {
  name: "list_uncovered_columns",
  description:
    "Return every table and column in this connector's dataset whose description is empty or unset. Call this exactly once at the start of your run to scope your work. Result includes top-level columns only — STRUCT leaf paths are filtered out.",
  inputSchema: ListUncoveredInput,
  handler: async (_raw, ctx): Promise<MetadataToolResult> => {
    const uncovered = await findUncoveredMetadata({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      connectorId: ctx.connectorId,
      bqDataset: ctx.bqDataset,
      bqLocation: ctx.bqLocation,
    });
    // Filter out STRUCT leaf paths — the writers don't support them in
    // this slice. The agent will see only column names it can act on.
    const flatColumns = uncovered.columns.filter(
      (c) => !c.fieldPath.includes("."),
    );
    return {
      content: {
        tables: uncovered.tables,
        columns: flatColumns.map((c) => ({
          table: c.table,
          column: c.fieldPath,
        })),
        totalTables: uncovered.tables.length,
        totalColumns: flatColumns.length,
      } satisfies {
        tables: UncoveredMetadata["tables"];
        columns: { table: string; column: string }[];
        totalTables: number;
        totalColumns: number;
      },
    };
  },
};

// ── sample_rows ──────────────────────────────────────────────────

const SampleRowsInput = z.object({
  table: z
    .string()
    .min(1)
    .describe("Table to sample, name only (the dataset is bound to your context)."),
  n: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Rows to return. Default 20. Max 50."),
});

// Validate table names match BQ's allowed identifier shape before
// interpolating into SQL. Belt-and-braces — BQ would reject malformed
// names anyway, but rejecting early gives a clean error.
const VALID_BQ_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeIdentifier(name: string, kind: string): void {
  if (!VALID_BQ_IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid ${kind} name: "${name}". Must match ${VALID_BQ_IDENTIFIER}.`,
    );
  }
}

const sampleRowsTool: MetadataToolDefinition = {
  name: "sample_rows",
  description:
    "Return a small sample of rows from a table. Sensitive values (anything matching common PII patterns) are server-side redacted before you see them. Use this to ground your descriptions in what the data actually looks like.",
  inputSchema: SampleRowsInput,
  handler: async (raw, ctx): Promise<MetadataToolResult> => {
    const { table, n = 20 } = SampleRowsInput.parse(raw);
    assertSafeIdentifier(table, "table");

    // TABLESAMPLE SYSTEM is BigQuery's cheap block-level sampler. The
    // 1% rate ensures very small tables still return rows (BQ takes a
    // whole block at minimum). LIMIT caps the actual return size.
    // We strip _sdc_ columns from the result so the agent doesn't try
    // to describe ingestion plumbing.
    const sql = `
      SELECT *
      FROM \`${ctx.bqDataset}\`.\`${table}\` TABLESAMPLE SYSTEM (1 PERCENT)
      LIMIT ${n}
    `;

    let result;
    try {
      result = await safeQuery(sql, {
        maxRows: n,
        location: ctx.bqLocation,
        context: {
          clientId: ctx.clientId,
          workspaceId: ctx.workspaceId,
          connectorId: ctx.connectorId,
        },
      });
    } catch (err) {
      // TABLESAMPLE doesn't work on very small tables in some cases —
      // fall back to a plain LIMIT scan. Costs at most 10 GB cap.
      const msg = err instanceof Error ? err.message : String(err);
      if (/TABLESAMPLE/i.test(msg) || /not supported/i.test(msg)) {
        result = await safeQuery(
          `SELECT * FROM \`${ctx.bqDataset}\`.\`${table}\` LIMIT ${n}`,
          {
            maxRows: n,
            location: ctx.bqLocation,
            context: {
              clientId: ctx.clientId,
              workspaceId: ctx.workspaceId,
              connectorId: ctx.connectorId,
            },
          },
        );
      } else {
        throw err;
      }
    }

    const rowsNoSdc = result.rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("_sdc_")) continue;
        out[k] = v;
      }
      return out;
    });

    const columnNames = rowsNoSdc.length > 0 ? Object.keys(rowsNoSdc[0]!) : [];
    const scrubbed = scrubSampleRows(rowsNoSdc, columnNames);

    return {
      content: {
        table,
        rowCount: scrubbed.length,
        rows: scrubbed,
        note: "Values matching PII patterns have been server-side redacted to <redacted>.",
      },
    };
  },
};

// ── column_profile ───────────────────────────────────────────────

const ColumnProfileInput = z.object({
  table: z.string().min(1),
  column: z
    .string()
    .min(1)
    .describe("Top-level column name. STRUCT leaf paths are not supported."),
});

const columnProfileTool: MetadataToolDefinition = {
  name: "column_profile",
  description:
    "Get distinct count, null %, and top values for a single column. Use this when the column's meaning isn't obvious from name + sample (e.g. an integer ID column where you want to know its range and uniqueness).",
  inputSchema: ColumnProfileInput,
  handler: async (raw, ctx): Promise<MetadataToolResult> => {
    const { table, column } = ColumnProfileInput.parse(raw);
    assertSafeIdentifier(table, "table");
    assertSafeIdentifier(column, "column");

    // Verify the column exists on the table before issuing the profile
    // query. Doubles as injection defence and as a clear error if the
    // agent fabricated a column name.
    const client = await bqReady();
    const [meta] = await client.dataset(ctx.bqDataset).table(table).getMetadata();
    const fields = (meta.schema?.fields ?? []) as { name: string; type?: string }[];
    const field = fields.find((f) => f.name === column);
    if (!field) {
      throw new Error(`Column "${column}" not found on table "${table}".`);
    }

    const ctxLabels = {
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      connectorId: ctx.connectorId,
    };

    // APPROX_COUNT_DISTINCT keeps the scan cheap on large tables; the
    // agent doesn't need exact cardinality for description quality.
    const baseSql = `
      SELECT
        COUNT(*) AS total_rows,
        COUNTIF(\`${column}\` IS NULL) AS null_count,
        APPROX_COUNT_DISTINCT(\`${column}\`) AS distinct_approx
      FROM \`${ctx.bqDataset}\`.\`${table}\`
    `;

    const topValuesSql = `
      SELECT CAST(\`${column}\` AS STRING) AS value, COUNT(*) AS n
      FROM \`${ctx.bqDataset}\`.\`${table}\`
      WHERE \`${column}\` IS NOT NULL
      GROUP BY value
      ORDER BY n DESC
      LIMIT 5
    `;

    const [baseResult, topResult] = await Promise.all([
      safeQuery(baseSql, {
        maxRows: 1,
        location: ctx.bqLocation,
        context: ctxLabels,
      }),
      safeQuery(topValuesSql, {
        maxRows: 5,
        location: ctx.bqLocation,
        context: ctxLabels,
      }),
    ]);

    // PII scrub applied to top values too — the agent shouldn't see
    // a frequency table of customer emails.
    const scrubbedTop = scrubSampleRows(
      (topResult.rows as Record<string, unknown>[]).map((r) => ({
        [column]: r.value,
        n: r.n,
      })),
      [column],
    ).map((r) => ({ value: r[column], count: r.n }));

    return {
      content: {
        table,
        column,
        type: field.type ?? "UNKNOWN",
        ...(baseResult.rows[0] ?? {}),
        topValues: scrubbedTop,
      },
    };
  },
};

// ── write_table_description ──────────────────────────────────────

const WriteTableInput = z.object({
  table: z.string().min(1),
  description: z
    .string()
    .min(10)
    .max(400)
    .describe(
      "One-sentence description of what the table represents, grounded in observed data. Max 400 chars.",
    ),
  semanticRole: z
    .string()
    .max(50)
    .optional()
    .describe(
      'Optional semantic role like "fact_transactions", "dim_customers", "log_events".',
    ),
});

const writeTableTool: MetadataToolDefinition = {
  name: "write_table_description",
  description:
    "Write a table-level description to BigQuery and mirror it to the metadata registry. Idempotent: re-running with a new description overwrites a previous agent-written one but never overwrites a human-edited or first-party-manifest description.",
  inputSchema: WriteTableInput,
  handler: async (raw, ctx): Promise<MetadataToolResult> => {
    const { table, description, semanticRole } = WriteTableInput.parse(raw);
    assertSafeIdentifier(table, "table");
    const result: WriteResult = await writeTableDescription({
      ctx: {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        connectorId: ctx.connectorId,
        bqDataset: ctx.bqDataset,
      },
      tableId: table,
      description,
      source: "agent",
      semanticRole,
    });
    return { content: result };
  },
};

// ── write_column_description ─────────────────────────────────────

const WriteColumnInput = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  description: z
    .string()
    .min(5)
    .max(400)
    .describe(
      "One-sentence description of the column, grounded in observed data. Max 400 chars.",
    ),
  semanticType: z
    .string()
    .max(50)
    .optional()
    .describe(
      'Optional semantic type like "currency", "identifier", "event_timestamp", "enum", "free_text".',
    ),
});

const writeColumnTool: MetadataToolDefinition = {
  name: "write_column_description",
  description:
    "Write a column-level description to BigQuery and mirror it to the registry. Idempotent over prior agent-written descriptions. Returns { written: false, reason } when the description is protected (human-edited or manifest).",
  inputSchema: WriteColumnInput,
  handler: async (raw, ctx): Promise<MetadataToolResult> => {
    const { table, column, description, semanticType } =
      WriteColumnInput.parse(raw);
    assertSafeIdentifier(table, "table");
    assertSafeIdentifier(column, "column");
    const result = await writeColumnDescription({
      ctx: {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        connectorId: ctx.connectorId,
        bqDataset: ctx.bqDataset,
      },
      tableId: table,
      columnName: column,
      description,
      source: "agent",
      semanticType,
    });
    return { content: result };
  },
};

// ── finish ───────────────────────────────────────────────────────

const FinishInput = z.object({
  reason: z
    .string()
    .max(200)
    .describe(
      'Short reason for stopping, e.g. "all-columns-described" or "tool-budget-exhausted".',
    ),
});

const finishTool: MetadataToolDefinition = {
  name: "finish",
  description:
    "Terminate the enrichment run. Call this when the worklist from list_uncovered_columns is fully addressed, or when you've exhausted your tool budget.",
  inputSchema: FinishInput,
  handler: async (raw): Promise<MetadataToolResult> => {
    const { reason } = FinishInput.parse(raw);
    return { content: { finished: true, reason } };
  },
};

// ── Registry + Gemini schema conversion ───────────────────────────

export const metadataTools: MetadataToolDefinition[] = [
  listUncoveredTool,
  sampleRowsTool,
  columnProfileTool,
  writeTableTool,
  writeColumnTool,
  finishTool,
];

const FINISH_TOOL_NAME = "finish";

/**
 * Same JSON-Schema → Gemini converter as the chat agent uses
 * ([src/lib/tools/index.ts]). Kept self-contained here to avoid
 * accidental coupling between the chat tool registry and the
 * metadata tool registry — they have different lifetimes and
 * different security postures.
 */
function jsonSchemaToGemini(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object") {
    return schema as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (
      k === "$schema" ||
      k === "$ref" ||
      k === "title" ||
      k === "additionalProperties"
    )
      continue;
    if (k === "type") {
      if (typeof v === "string") out[k] = v.toUpperCase();
      continue;
    }
    if (k === "properties") {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const propsOut: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(
          v as Record<string, unknown>,
        )) {
          propsOut[propName] =
            typeof propSchema === "object" && propSchema !== null
              ? jsonSchemaToGemini(propSchema)
              : propSchema;
        }
        out[k] = propsOut;
      }
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "object" && item !== null
          ? jsonSchemaToGemini(item)
          : item,
      );
    } else if (typeof v === "object" && v !== null) {
      out[k] = jsonSchemaToGemini(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function metadataFunctionDeclarations(): FunctionDeclaration[] {
  return metadataTools.map((t) => {
    const schema = zodToJsonSchema(t.inputSchema, {
      target: "jsonSchema7",
      $refStrategy: "none",
    });
    return {
      name: t.name,
      description: t.description,
      parameters: jsonSchemaToGemini(
        schema,
      ) as unknown as FunctionDeclaration["parameters"],
    };
  });
}

const byName = new Map(metadataTools.map((t) => [t.name, t]));

export async function executeMetadataTool(
  name: string,
  rawInput: unknown,
  ctx: MetadataAgentContext,
  budget: ToolBudget,
): Promise<MetadataToolResult> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`Unknown metadata tool: ${name}`);
  if (budget.remaining <= 0 && name !== FINISH_TOOL_NAME) {
    return {
      content: {
        error: "tool-budget-exhausted",
        message:
          "You have used your full tool budget for this run. Call finish with reason 'tool-budget-exhausted' to terminate.",
      },
    };
  }
  if (name !== FINISH_TOOL_NAME) budget.remaining -= 1;
  return tool.handler(rawInput, ctx, budget);
}

export function isFinishToolName(name: string): boolean {
  return name === FINISH_TOOL_NAME;
}
