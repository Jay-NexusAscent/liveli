import type {
  Content,
  FunctionCall,
  GenerateContentCandidate,
  Part,
} from "@google-cloud/vertexai";
import { buildModel, vertexReady, MODEL } from "@/lib/vertex";
import { vertexRegionForResidency } from "@/lib/gcp";
import { bqReady } from "@/lib/bigquery";
import { logMetadataAgentRun } from "@/lib/usage";
import {
  executeMetadataTool,
  isFinishToolName,
  metadataFunctionDeclarations,
  type MetadataAgentContext,
  type ToolBudget,
} from "./tools";
import { writeDatasetDescription } from "./writers";

/**
 * Per-run cap on individual tool invocations. Each table costs
 * ~15 tool calls (1 sample_rows + ~12 write_column_description + 1
 * write_table_description + occasional column_profile for ambiguous
 * columns). The dataset description is NOT in this budget — it's
 * written by the deterministic finalizer after the main loop ends.
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
 * 300-450s. Below the 600s `maxDuration` on /api/connectors.
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

Workflow — work strictly table-by-table:

1. Call list_uncovered_columns ONCE to scope your work.
2. Pick the first table in the worklist. Call sample_rows({ table }) — once.
3. IMMEDIATELY write descriptions for ALL of that table's uncovered columns. Emit ALL write_column_description calls for the table in a SINGLE response — Gemini supports parallel function calls in one turn, and batching them this way is essential for staying inside the turn budget.
4. After the column writes, call write_table_description for that same table.
5. ONLY THEN move to the next table. Do NOT call sample_rows for table B before all writes for table A are issued.
6. Use column_profile sparingly — only for genuinely ambiguous columns (e.g., an opaque numeric column where you can't tell from name + samples whether it's a PK, an FK, or a measure). Skip it on obvious columns like "email", "created_at", "first_name".
7. Call finish({ reason: "all-described" }) when the worklist is empty, or finish({ reason: "tool-budget-exhausted" }) if you've used your budget.

The most common failure mode is sampling multiple tables before writing any descriptions — that burns through turns reading data without producing any output. Don't do it. Finish each table completely before touching the next.

The dataset-level description is synthesized automatically AFTER your run from the table descriptions you write. You do NOT have a tool for this and do NOT need to think about it — it's a separate deterministic step that the runner handles. Your only job is per-table enrichment.

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

    // Deterministic dataset-description finalizer.
    //
    // The agent's job is per-entity (tables + columns). Synthesizing
    // a dataset summary is a different kind of task — it's a fold
    // over already-written table descriptions, not grounded sampling
    // — and shoehorning it into the same tool-loop made it the
    // unreliable step: an LLM with 100+ turns of conversation behind
    // it would skip the "final step" or run out of budget just
    // before it.
    //
    // Doing it here, outside the loop, in a focused single-call
    // synthesis, makes it bulletproof:
    //   - Always runs, regardless of how the main loop ended
    //     (finish, max-turns, or no-tool-calls).
    //   - Gets a clean context — just the table descriptions, no
    //     per-row sampling noise.
    //   - Never competes with per-table work for turn budget.
    //
    // Wrapped in try/catch so a synthesis failure can't fail the
    // overall run — the gate-and-resume on /api/connectors will
    // pick up the still-missing dataset description on the next
    // sync if this one fails.
    let datasetDescriptionWritten = false;
    try {
      datasetDescriptionWritten = await finalizeDatasetDescription(ctx, region);
    } catch (err) {
      console.error("[metadata-agent] dataset finalizer failed", {
        connectorId: ctx.connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
      datasetDescriptionWritten,
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

/**
 * Synthesize a 1-2 sentence dataset description from the table
 * descriptions already written into the BigQuery dataset, and store
 * it via the shared writer (which mirrors to Firestore + applies
 * source-protection so we never clobber a human-edited description).
 *
 * Why this lives outside the main agent loop: see the long comment
 * at the call site. TL;DR — synthesis is a different task class
 * than per-entity enrichment and shouldn't share the tool-loop's
 * turn budget. Doing it here guarantees the dataset description
 * lands every run, even when the main loop ran out of turns or the
 * agent skipped a "step 7" instruction.
 *
 * Idempotency:
 *   - If the dataset already has a description, returns without
 *     touching it. Preserves human edits and prior agent runs.
 *   - If there are no table descriptions to synthesize from
 *     (genuinely empty dataset), returns false without writing.
 *
 * Returns true iff a new description was written this run.
 */
async function finalizeDatasetDescription(
  ctx: MetadataAgentContext,
  region: string,
): Promise<boolean> {
  const start = Date.now();

  const client = await bqReady();

  // Skip if the dataset already has a description. The writer also
  // enforces source-protection (won't overwrite human edits), but
  // skipping here avoids an unnecessary Gemini call when we already
  // know the answer.
  let existingDesc = "";
  try {
    const [datasetMeta] = await client.dataset(ctx.bqDataset).getMetadata();
    existingDesc =
      typeof datasetMeta.description === "string" ? datasetMeta.description : "";
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) {
      console.warn("[metadata-agent] dataset finalizer skip — dataset 404", {
        connectorId: ctx.connectorId,
        bqDataset: ctx.bqDataset,
      });
      return false;
    }
    throw err;
  }
  if (existingDesc.trim() !== "") {
    console.log("[metadata-agent] dataset finalizer skip — already described", {
      connectorId: ctx.connectorId,
      existingLength: existingDesc.length,
    });
    return false;
  }

  // Gather the table descriptions just written by this run (or by a
  // previous run — either way, they're the freshest grounded
  // summaries of the schema).
  const [tables] = await client.dataset(ctx.bqDataset).getTables();
  const tableDescriptions: { table: string; description: string }[] = [];
  await Promise.all(
    tables.map(async (t) => {
      const [m] = await t.getMetadata();
      const desc = typeof m.description === "string" ? m.description : "";
      if (t.id && desc.trim() !== "") {
        tableDescriptions.push({ table: t.id, description: desc });
      }
    }),
  );
  tableDescriptions.sort((a, b) => a.table.localeCompare(b.table));

  if (tableDescriptions.length === 0) {
    console.warn(
      "[metadata-agent] dataset finalizer skip — no table descriptions to synthesize from",
      { connectorId: ctx.connectorId },
    );
    return false;
  }

  // Single-shot Gemini synthesis call — no tools, no streaming, no
  // loop. Just: "given these table descriptions, write a 1-2 sentence
  // dataset summary." This is purely deterministic from the runner's
  // perspective: the call either succeeds and we write, or it fails
  // and we log + return false.
  const synthesisModel = buildModel(region, {
    systemInstruction: {
      role: "system",
      parts: [
        {
          text:
            // CRITICAL framing: the dataset description is read by the
            // downstream chat agent when grounding SQL generation. The
            // data LIVES IN BIGQUERY and is queried with BigQuery SQL —
            // any phrasing that primes the reader toward a different
            // SQL dialect ("Postgres database containing…") causes
            // wasted turns when the chat agent later generates
            // Postgres-flavoured syntax that BQ rejects (`::int` casts,
            // `DISTINCT ON`, `EXTRACT(epoch FROM …)`, etc.). Lead with
            // the business domain; mention the source as a qualifier
            // only — never as the head noun.
            "You write concise BigQuery dataset descriptions. The dataset lives in BigQuery and is queried with BigQuery SQL — descriptions must not suggest otherwise. Lead with what the data represents (the business domain); mention the source connector only as a parenthetical qualifier, never as the head noun. Output a single 1-2 sentence description. Be concrete and scannable. No preamble, no markdown, no quotation marks around the output.",
        },
      ],
    },
  });

  const prompt = `Connector type: ${ctx.connectorType}
Dataset: ${ctx.bqDataset}

Table descriptions (one row per table):
${tableDescriptions.map((t) => `- ${t.table}: ${t.description}`).join("\n")}

Write the dataset description now. The data lives in BigQuery — lead
with the business domain, not the source system. Example shapes
(notice each one's grammatical subject is the data, not the source):
- "Retail e-commerce data replicated from a Postgres source: customers, orders, order_items, products, sessions, shipments, returns, and product reviews."
- "Stripe payments data — charges, customers, subscriptions, invoices, payouts, and refunds for the linked account."
- "HubSpot CRM data — contacts, deals, companies, engagements, tickets, owners, and products."

Output only the description.`;

  const result = await synthesisModel.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 256, temperature: 0.3 },
  });

  const candidate = result.response.candidates?.[0] as
    | GenerateContentCandidate
    | undefined;
  const rawText =
    candidate?.content?.parts
      ?.map((p: Part) => p.text ?? "")
      .join("")
      .trim() ?? "";

  // Defensive cleanup: strip wrapping quotes (Gemini sometimes adds
  // them despite the system instruction) and clamp to the writer's
  // 600-char max.
  const cleaned = rawText
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .slice(0, 600);

  if (cleaned.length < 20) {
    console.warn(
      "[metadata-agent] dataset finalizer skip — model output too short",
      {
        connectorId: ctx.connectorId,
        outputLength: cleaned.length,
        rawPreview: rawText.slice(0, 100),
      },
    );
    return false;
  }

  const writeResult = await writeDatasetDescription({
    ctx: {
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      connectorId: ctx.connectorId,
      bqDataset: ctx.bqDataset,
    },
    description: cleaned,
    source: "agent",
  });

  console.log("[metadata-agent] dataset finalizer complete", {
    connectorId: ctx.connectorId,
    written: writeResult.written,
    skipReason: writeResult.reason,
    descriptionPreview: cleaned.slice(0, 120),
    tableDescriptionsUsed: tableDescriptions.length,
    durationMs: Date.now() - start,
  });

  return writeResult.written;
}
