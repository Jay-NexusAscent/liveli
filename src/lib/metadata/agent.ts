import type {
  Content,
  FunctionCall,
  GenerateContentCandidate,
  Part,
} from "@google-cloud/vertexai";
import { buildModel, vertexReady, MODEL } from "@/lib/vertex";
import { vertexRegionForResidency } from "@/lib/gcp";
import { logMetadataAgentRun } from "@/lib/usage";
import {
  executeMetadataTool,
  isFinishToolName,
  metadataFunctionDeclarations,
  type MetadataAgentContext,
  type ToolBudget,
} from "./tools";

/**
 * Per-run cap on individual tool invocations. Each table costs
 * ~15 tool calls (1 sample_rows + ~12 write_column_description + 1
 * write_table_description + occasional column_profile for ambiguous
 * columns). The dataset adds 1 write_dataset_description + 1 finish.
 *
 *   schema size      → tool calls budget needed
 *   9 tables (demo)  → ~150
 *   20 tables        → ~310
 *   50 tables        → ~770
 *
 * 800 covers up to ~50 tables in one shot — sized for real customer
 * databases, not just the demo. Connectors with larger schemas
 * (enterprise data warehouses with 100+ tables) still progress
 * across runs via the same gate-and-resume mechanism: the
 * dispatcher's pre-flight gate re-runs on every /api/connectors
 * poll, sees the remaining uncovered fields, and re-triggers the
 * agent. So the worst case for a huge schema is "complete in 2-3
 * syncs" rather than "stuck forever."
 *
 * For schemas big enough that even 2-3 sequential runs are slow
 * (think 500+ tables), the right answer is parallel-dispatch
 * (chunked agent invocations running concurrently via `after()`) —
 * tracked as a follow-up architectural change. Not in this PR.
 *
 * Cost note: each tool call adds ~150 tokens of args + ~50 tokens
 * of response to the history. At Gemini Flash prices that's ~$0.0001
 * per tool call. 800 calls = ~$0.08 per run worst-case, but most
 * customers will hit ~150-300 calls and stay around $0.01-$0.03.
 */
const MAX_TOOL_CALLS = 800;

/**
 * Hard limit on Gemini round-trips. **This is the binding ceiling
 * for large schemas**, not MAX_TOOL_CALLS. Each table costs ~3 turns:
 *   1. sample_rows
 *   2. batched write_column_description for all columns + write_
 *      table_description (Gemini supports parallel function calls in
 *      a single turn, the system prompt requires this batching).
 *   3. Sometimes a column_profile retry on an ambiguous column.
 *
 * So 150 turns covers ~50 tables comfortably. Same break-points as
 * MAX_TOOL_CALLS above:
 *
 *   schema size      → turns needed
 *   9 tables (demo)  → ~25
 *   20 tables        → ~60
 *   50 tables        → ~150
 *
 * Wall-time check: at ~2-3s per Gemini round-trip × 150 turns ≈
 * 300-450s. Below the 600s `maxDuration` on /api/connectors (bumped
 * in this PR from 300s for the same reason).
 *
 * Push much above 150 and you risk the function-lifetime cap — at
 * which point the right answer is parallel dispatch, not a bigger
 * single-run budget.
 */
const MAX_TURNS = 150;

const SYSTEM_PROMPT_TEMPLATE = `You are the Liveli Metadata Enrichment Agent.

Your sole job: describe BigQuery tables and columns that landed via a customer's data connector. Downstream consumers (the chat agent, BI tools, the analytics team) read these descriptions, so they must be concrete and grounded in observed data.

You work on ONE connector at a time. The dataset, tables and columns you can see all belong to this one connector. You cannot reach any other tenant's data; your tools refuse if asked.

Connector context:
- type: {{CONNECTOR_TYPE}}
- dataset: {{DATASET_NAME}}

Workflow — work strictly table-by-table, then close with the dataset:

1. Call list_uncovered_columns ONCE to scope your work.
2. Pick the first table in the worklist. Call sample_rows({ table }) — once.
3. IMMEDIATELY write descriptions for ALL of that table's uncovered columns. Emit ALL write_column_description calls for the table in a SINGLE response — Gemini supports parallel function calls in one turn, and batching them this way is essential for staying inside the turn budget.
4. After the column writes, call write_table_description for that same table.
5. ONLY THEN move to the next table. Do NOT call sample_rows for table B before all writes for table A are issued.
6. Use column_profile sparingly — only for genuinely ambiguous columns (e.g., an opaque numeric column where you can't tell from name + samples whether it's a PK, an FK, or a measure). Skip it on obvious columns like "email", "created_at", "first_name".
7. After ALL tables are described, call write_dataset_description ONCE with a 1-2 sentence summary. Name the source type explicitly (you have it in your context above) and the data domain the dataset represents, derived from the tables you've seen. Example shapes:
   - "Postgres database containing retail e-commerce data: customers, orders, order_items, products, sessions, shipments, returns, and product reviews — roughly two years of trading history with realistic UK diurnal + weekly + seasonal patterns."
   - "Stripe payments connector — charges, customers, subscriptions, invoices, payouts, and refunds for the linked Stripe account."
   - "HubSpot CRM connector — contacts, deals, companies, engagements, tickets, owners, and products."
   This is the description downstream consumers (chat agent, BI tools) see when listing datasets, so make it scannable and concrete.
8. Call finish({ reason: "all-described" }) when the dataset description has been written and the worklist is empty, or finish({ reason: "tool-budget-exhausted" }) if you've used your budget before reaching step 7.

The most common failure mode is sampling multiple tables before writing any descriptions — that burns through turns reading data without producing any output. Don't do it. Finish each table completely before touching the next.

Rules:
- Be concrete, not generic.
    BAD: "Stores customer data."
    GOOD: "One row per customer; includes email, signup date, and current plan."
- Ground descriptions in observed data. Use samples, don't guess.
- ONE sentence per description. Max 400 chars.
- If samples are ambiguous, say so honestly: "Numeric ID, monotonically increasing from 1 — likely a sequential primary key" beats "Stores ID values".
- Never invent semantics. If a column's purpose is still unclear after sampling, write "Purpose unclear; <distinct count> distinct values; examples: <a, b, c>" and move on.
- Sample values may contain "<redacted>" placeholders — this is server-side PII protection. Describe the column from its name + the unredacted values you can see.
- Singer/Meltano internal columns (_sdc_*) are filtered out before you see them. Do not ask about them.
- Your tools take a bare table name and column name. The dataset is bound to your context — never include it as an argument.
- Hard budget: ${MAX_TOOL_CALLS} tool calls and ${MAX_TURNS} turns per run. If you exhaust either, call finish with reason "tool-budget-exhausted".

Current date: {{CURRENT_DATE}}.`;

export interface MetadataAgentResult {
  status: "finished" | "max-turns" | "error";
  reason?: string;
  toolCallsUsed: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error?: string;
}

/**
 * Run the metadata enrichment agent end-to-end against one connector.
 *
 * Non-streaming — there's no user-facing UI to stream to. We collect
 * tool results and write metadata back to BigQuery + Firestore as
 * tools are called. Returns a summary suitable for server logs.
 *
 * The agent is single-shot per call: there's no conversation memory
 * across runs. Successive syncs re-run the pre-flight gate and only
 * the remaining gaps show up in the worklist, so progress accumulates
 * naturally across runs.
 *
 * Tenancy: the connector context is verified against the dataset name
 * (via the writers and the pre-flight gate). The tools never accept a
 * dataset argument from the model — they read it from this ctx.
 */
export async function runMetadataAgent(
  ctx: MetadataAgentContext,
): Promise<MetadataAgentResult> {
  const startedAt = Date.now();
  const budget: ToolBudget = { remaining: MAX_TOOL_CALLS };

  const region = vertexRegionForResidency(
    ctx.bqLocation === "US" || ctx.bqLocation === "EU"
      ? (ctx.bqLocation as "EU" | "US")
      : undefined,
  );

  try {
    await vertexReady(region);
  } catch (err) {
    return {
      status: "error",
      error: `vertexReady failed: ${err instanceof Error ? err.message : String(err)}`,
      toolCallsUsed: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
    "{{CONNECTOR_TYPE}}",
    ctx.connectorType,
  )
    .replace("{{DATASET_NAME}}", ctx.bqDataset)
    .replace("{{CURRENT_DATE}}", new Date().toISOString().split("T")[0]!);

  const fnDecls = metadataFunctionDeclarations();
  const model = buildModel(region, {
    systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
    tools: [{ functionDeclarations: fnDecls }],
  });

  // History always starts with a single user message instructing the
  // agent to begin. Gemini's API requires at least one Content with
  // user role; without it the model has nothing to react to.
  const history: Content[] = [
    {
      role: "user",
      parts: [
        {
          text: "Begin the metadata enrichment workflow. Start by calling list_uncovered_columns to scope your work.",
        },
      ],
    },
  ];

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let toolCallsUsed = 0;
  let finishReason: string | undefined;
  let turn = 0;

  try {
    while (turn < MAX_TURNS) {
      turn++;
      const turnStart = Date.now();

      const result = await model.generateContentStream({
        contents: history,
        generationConfig: { maxOutputTokens: 2048 },
      });

      const turnTextParts: string[] = [];
      const turnFunctionCalls: FunctionCall[] = [];

      for await (const chunk of result.stream) {
        const candidate = chunk.candidates?.[0] as
          | GenerateContentCandidate
          | undefined;
        const parts = candidate?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.text) turnTextParts.push(part.text);
            if (part.functionCall) turnFunctionCalls.push(part.functionCall);
          }
        }
        const usage = chunk.usageMetadata;
        if (usage) {
          totalTokensIn += usage.promptTokenCount ?? 0;
          totalTokensOut += usage.candidatesTokenCount ?? 0;
        }
      }

      // Record the assistant turn into history.
      const turnParts: Part[] = [];
      if (turnTextParts.length > 0) turnParts.push({ text: turnTextParts.join("") });
      for (const fc of turnFunctionCalls) turnParts.push({ functionCall: fc });
      if (turnParts.length > 0) {
        history.push({ role: "model", parts: turnParts });
      }

      console.log("[metadata-agent] turn", {
        turn,
        connectorId: ctx.connectorId,
        toolCalls: turnFunctionCalls.map((fc) => fc.name),
        textPreview: turnTextParts.join("").slice(0, 200),
        budgetRemaining: budget.remaining,
        tokenInRunning: totalTokensIn,
        tokenOutRunning: totalTokensOut,
        turnMs: Date.now() - turnStart,
      });

      // No function calls → agent produced only text → we're done.
      if (turnFunctionCalls.length === 0) {
        finishReason = "no-tool-calls";
        break;
      }

      // Execute the function calls and append results.
      const fnResultParts: Part[] = [];
      let sawFinish = false;
      for (const fc of turnFunctionCalls) {
        const fnName = fc.name ?? "";
        const fnArgs = (fc.args ?? {}) as Record<string, unknown>;
        toolCallsUsed++;
        let toolResult;
        try {
          toolResult = await executeMetadataTool(fnName, fnArgs, ctx, budget);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[metadata-agent] tool error", {
            connectorId: ctx.connectorId,
            tool: fnName,
            args: fnArgs,
            error: msg,
          });
          toolResult = { content: { error: msg } };
        }
        fnResultParts.push({
          functionResponse: {
            name: fnName,
            response: toolResult.content as Record<string, unknown>,
          },
        });
        if (isFinishToolName(fnName)) {
          sawFinish = true;
          finishReason =
            typeof (toolResult.content as { reason?: string })?.reason === "string"
              ? (toolResult.content as { reason: string }).reason
              : "finish";
        }
      }

      history.push({ role: "user", parts: fnResultParts });

      if (sawFinish) break;
    }

    const status: MetadataAgentResult["status"] =
      turn >= MAX_TURNS && !finishReason ? "max-turns" : "finished";

    const summary: MetadataAgentResult = {
      status,
      reason: finishReason,
      toolCallsUsed,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      durationMs: Date.now() - startedAt,
    };

    logMetadataAgentRun({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      connectorId: ctx.connectorId,
      model: MODEL,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      executionMs: summary.durationMs,
      toolCallsUsed,
      status,
    });

    console.log("[metadata-agent] run complete", {
      connectorId: ctx.connectorId,
      ...summary,
    });

    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[metadata-agent] run failed", {
      connectorId: ctx.connectorId,
      error: msg,
      turn,
      toolCallsUsed,
    });
    const summary: MetadataAgentResult = {
      status: "error",
      error: msg,
      toolCallsUsed,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      durationMs: Date.now() - startedAt,
    };
    logMetadataAgentRun({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      connectorId: ctx.connectorId,
      model: MODEL,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      executionMs: summary.durationMs,
      toolCallsUsed,
      status: "error",
    });
    return summary;
  }
}
