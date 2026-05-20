import { FieldValue } from "@google-cloud/firestore";
import type {
  Content,
  FunctionCall,
  GenerateContentCandidate,
  Part,
} from "@google-cloud/vertexai";
import { buildModel, vertexReady, MODEL } from "@/lib/vertex";
import { ensureGcpAuth } from "@/lib/gcp-auth";
import { gcp, vertexRegionForResidency } from "@/lib/gcp";
import {
  executeTool,
  geminiFunctionDeclarations,
  type AgentContext,
} from "@/lib/tools";
import { dbReady, chatsIn, messagesIn, workspaceDoc } from "@/lib/firestore";
import { logAgentMessage } from "@/lib/usage";
import type { ChatStreamEvent } from "@/lib/streaming";

const SYSTEM_PROMPT = `You are **Liveli**, an AI data analyst inside a B2B SaaS product. The user has connected one or more data sources to a managed BigQuery warehouse. You help by:

1. Inspecting the warehouse schema (always call \`list_tables\` first if you don't know what tables exist).
2. Writing read-only BigQuery Standard SQL to answer the question (call \`run_sql\`).
3. Visualising the answer with a chart whenever it helps (call \`make_chart\` with a valid ECharts option). Prefer charts over plain numbers.
4. Composing multiple charts into a dashboard when the user asks for an "overview", "summary", or "report" (call \`make_dashboard\`).
5. Explaining the result conversationally — like a sharp junior analyst presenting a finding.

Rules:
- ALWAYS call \`list_tables\` before writing SQL if you haven't seen the schema this turn.
- **NEVER guess column names.** Use ONLY columns that appeared in the \`list_tables\` response (each table has a \`columns\` array with the real \`name\` + \`type\`). Common defaults like \`created_at\`, \`user_id\`, \`status\` are NOT guaranteed to exist — verify before writing SQL. If you can't find the column you want, look again at \`list_tables\` output (the schema is in this conversation's history) or call \`list_tables\` again. Hallucinating a column wastes a BQ scan and trust.
- Each connector has its own BigQuery dataset (named like \`c_<id>__w_<id>__d_<connectorId>\`). The \`list_tables\` response gives you a \`dataset\` field per table — use it to **fully qualify** every table in your SQL: \`SELECT * FROM \\\`dataset.table\\\`\`.
- Wrap fully-qualified names in backticks because dataset names contain underscores BigQuery's parser can be picky about.
- If the user asks about "their data" without specifying a source, query across all relevant connectors' datasets (UNION ALL where the schema matches, or describe what each source has).
- READ-ONLY queries only: SELECT and WITH allowed. Never DDL, UPDATE, DELETE, INSERT, MERGE.
- Keep queries efficient: aggregate, filter, LIMIT. The dataset has a 10 GB scan cap.
- **Never \`SELECT *\`** — explicitly list the columns the user cares about. Tables often have noisy sync-metadata columns (anything starting with an underscore like \`_sdc_*\`) that are filtered out anyway, but listing real columns also keeps results tidy.
- **Do NOT re-emit run_sql rows as a markdown table in your reply.** The client renders the result rows in a dedicated table UI automatically — repeating them as markdown is duplicate and clutters the response. Comment on what the data shows, don't reproduce it.
- **Answer ONLY what the user asked.** Don't initiate follow-up queries, alternative views, or "while we're here, let's also look at…" tangents. Each unrequested SQL run is a billable BQ scan and a billable Vertex token spend. Answer the question, then stop and wait for the user's next message.
- For charts: pick the right type (bar for ranking, line for time series, pie for share-of-total, scatter for correlation). Always set a title. When the user asks for a chart, prefer \`make_chart\` over reciting numbers.
- **Chart data shape**: \`series[].data\` is a **flat array of numbers**, never a 2D array of [date, value] pairs. Put the dates / category labels in \`xAxis.data\` as strings, aligned by index. Example for a time series:
    \`xAxis: { type: "category", data: ["2026-05-01", "2026-05-02", "2026-05-03"] }\`
    \`series: [{ type: "line", data: [120, 145, 132] }]\`
- **\`make_chart\` argument shape — STRICT.** The function takes \`{ title, echartsOption }\`. Every ECharts field (xAxis, yAxis, series, tooltip, legend, grid) goes INSIDE \`echartsOption\`. Do NOT put \`series\` or \`yAxis\` at the top level alongside \`title\`. Correct:
    \`{ "title": "...", "echartsOption": { "xAxis": {...}, "yAxis": {...}, "series": [...] } }\`
- **For \`make_dashboard\`**: run ALL the SQL queries you need first, build the complete chart specs in memory, then call \`make_dashboard\` **once** with every chart fully populated. Do NOT call \`make_dashboard\` first with an empty placeholder and try to fill it in later — there's no way to update an existing dashboard from chat.
- Write conversationally and **keep markdown minimal**: short paragraphs, occasional bold for emphasis, simple bullet lists when listing items. Avoid headings (\`#\`), nested bullets, or markdown tables. Don't say "I will now call the run_sql tool" — just call it and present the result.
- If the result is empty or unexpected, say so plainly.
- Use the current date for any "last quarter / this month / YTD" references.

Current date: ${new Date().toISOString().split("T")[0]}.`;

// Max agent turns per user message — prevents infinite tool loops.
const MAX_TURNS = 8;

/**
 * Emit a single-line summary of an agent turn for production timing
 * visibility. We bias toward one line per turn rather than many fine-
 * grained logs because Vercel's runtime log MCP aggregates by request
 * row and truncates content — a compact JSON summary survives that
 * aggregation, individual sub-logs get hidden.
 *
 * Read the log when chats hang or feel slow: each turn's `totalMs`
 * shows whether budget is going to Vertex (`vertexCallMs` + `streamMs`),
 * tools (`toolsMs` + per-tool breakdown), or auth (`authMs`).
 */
function logTurnComplete(
  turn: number,
  turnStart: number,
  metrics: {
    authMs: number;
    vertexCallMs: number;
    streamMs: number;
    toolsMs: number;
    toolsExecuted: Array<{ name: string; ms: number; ok: boolean }>;
  },
  hasMoreTurns: boolean
): void {
  console.log("[agent] turn complete", {
    turn,
    totalMs: Date.now() - turnStart,
    authMs: metrics.authMs,
    vertexCallMs: metrics.vertexCallMs,
    streamMs: metrics.streamMs,
    toolsMs: metrics.toolsMs,
    toolsExecuted: metrics.toolsExecuted,
    hasMoreTurns,
  });
}

/**
 * Walk an Error's `.cause` chain (and the SDK's custom `.stackTrace`
 * alias) and produce a single readable string covering every layer.
 *
 * Why: @google-cloud/vertexai wraps fetch failures twice. The outer
 * wrap message is just "exception posting request" — the URL lives
 * one layer down, our patch's body content lives two layers down.
 * `err.message` alone reveals none of that. This walker surfaces all
 * layers in one string the SSE error event can carry to the UI.
 *
 * Each layer is capped at 400 chars; Bearer tokens are redacted so
 * the request's JSONified Authorization header doesn't leak to the
 * browser via the error message.
 */
function flattenErrorChain(e: unknown, maxDepth = 8): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < maxDepth) {
    if (cur instanceof Error) {
      let msg = cur.message ?? "";
      msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]");
      if (msg.length > 400) msg = msg.slice(0, 400) + "…";
      parts.push(`[${cur.name}] ${msg}`);
      const next = cur as Error & { cause?: unknown; stackTrace?: unknown };
      const candidate = next.cause ?? next.stackTrace;
      if (!candidate || candidate === cur) break;
      cur = candidate;
    } else {
      let s = String(cur);
      if (s.length > 400) s = s.slice(0, 400) + "…";
      parts.push(s);
      break;
    }
    depth++;
  }
  return parts.join(" ↳ ");
}

export interface AgentTurnInput {
  clientId: string;
  workspaceId: string;
  userId: string;
  chatId?: string;
  userMessage: string;
}

/**
 * Run one full agent turn against Gemini. Streams text deltas to the
 * client, dispatches function calls server-side, appends their results
 * to the conversation, loops until Gemini stops calling functions.
 *
 * Persists user + assistant messages to Firestore at
 *   clients/{clientId}/workspaces/{workspaceId}/chats/{chatId}/messages
 *
 * Gemini's streaming differs from Anthropic's in two important ways:
 *  1. No content-block boundaries — chunks contain Parts which can be
 *     text or functionCall. Text streams in deltas; functionCalls
 *     arrive whole (args don't split across chunks).
 *  2. The chat history is sent fresh on every turn (no SDK-managed
 *     state) — we maintain it ourselves in `history` and re-send.
 */
export async function* runAgentTurn(
  input: AgentTurnInput
): AsyncGenerator<ChatStreamEvent> {
  await ensureGcpAuth();

  // ── Resolve workspace residency → Vertex region ─────────────────
  // The workspace owns the data-residency choice; the agent's
  // inference region must match so we don't leak EU customer data
  // to US inference endpoints (or vice versa). bqLocation is the
  // single source of truth — set at workspace creation, immutable.
  await dbReady();
  const wsSnap = await workspaceDoc(input.clientId, input.workspaceId).get();
  const wsData = wsSnap.data() as { bqLocation?: "EU" | "US" } | undefined;
  const vertexRegion = vertexRegionForResidency(wsData?.bqLocation);

  // ── Open or create the chat ────────────────────────────────────
  const chatsCol = chatsIn(input.clientId, input.workspaceId);
  const chatRef = input.chatId ? chatsCol.doc(input.chatId) : chatsCol.doc();

  const isNewChat = !input.chatId;
  if (isNewChat) {
    await chatRef.set({
      createdBy: input.userId,
      createdAt: FieldValue.serverTimestamp(),
      title: input.userMessage.slice(0, 80),
    });
  }

  const chatId = chatRef.id;
  const messagesCol = messagesIn(input.clientId, input.workspaceId, chatId);

  // Append user message
  const userMsgRef = messagesCol.doc();
  await userMsgRef.set({
    role: "user",
    content: input.userMessage,
    createdAt: FieldValue.serverTimestamp(),
  });

  // ── Load conversation history (up to last 40 messages) ─────────
  const historySnap = await messagesCol
    .orderBy("createdAt", "asc")
    .limit(40)
    .get();

  type MsgContent =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: unknown };

  const history: Content[] = [];

  for (const doc of historySnap.docs) {
    const data = doc.data() as {
      role: "user" | "assistant";
      content: string;
      toolBlocks?: MsgContent[];
    };
    // Gemini uses role: "user" | "model" (not "assistant").
    const role = data.role === "assistant" ? "model" : "user";
    if (data.toolBlocks && data.toolBlocks.length > 0) {
      // CRITICAL: don't merge into one Content. Gemini rejects a Content
      // turn that mixes functionCall and functionResponse parts with:
      //   "function call turn contains at least one function_call part
      //    which can not be mixed with function_response"
      // tool_result parts must live on a {role: "user"} turn, separate
      // from any preceding text/tool_use on the assistant's {role: "model"}
      // turn. Split the flat block list back into alternating turns.
      history.push(...blocksToGeminiTurns(data.toolBlocks));
    } else {
      history.push({ role, parts: [{ text: data.content }] });
    }
  }

  // ── Announce chat to client ────────────────────────────────────
  const assistantMsgRef = messagesCol.doc();
  yield { type: "message_start", chatId, messageId: assistantMsgRef.id };

  const ctx: AgentContext = {
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    chatId,
    // Deprecated alias retained until all tools migrate off orgId.
    orgId: input.clientId,
  };

  const assistantText: string[] = [];
  const finalToolBlocks: MsgContent[] = [];
  const turnStartedAt = Date.now();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let usageLogged = false;

  // Ensure usage is logged EXACTLY ONCE, regardless of how this generator
  // ends — normal completion, exception, or client-side cancellation
  // (e.g. user closes tab / aborts fetch). Without this guarantee we
  // silently lose token costs that the customer should be billed for.
  const flushUsage = () => {
    if (usageLogged) return;
    usageLogged = true;
    logAgentMessage({
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      chatId,
      model: MODEL,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      executionMs: Date.now() - turnStartedAt,
    });
  };

  try {

  // ── Agentic loop ────────────────────────────────────────────────
  let turn = 0;
  while (turn < MAX_TURNS) {
    turn++;

    // Per-turn timing — surfaced as one compact log line at end of
    // each iteration so we can see where the 60s budget goes when a
    // chat hangs. Vercel runtime log MCP truncates content but
    // preserves whole-line JSON, so one summary line per turn is the
    // most useful shape.
    const turnStart = Date.now();
    const turnMetrics = {
      authMs: 0,
      vertexCallMs: 0,
      streamMs: 0,
      toolsMs: 0,
      toolsExecuted: [] as Array<{ name: string; ms: number; ok: boolean }>,
    };

    // Wrap each external call with tagged try/catch so failures
    // surface their actual source.
    const authStart = Date.now();
    try {
      await vertexReady(vertexRegion); // ensures ADC is written before the SDK reads it
    } catch (err) {
      const wrapped = new Error(
        `vertexReady failed (auth/ADC): ${err instanceof Error ? err.message : String(err)}`
      );
      (wrapped as Error & { source?: string }).source = "vertexReady";
      throw wrapped;
    }
    turnMetrics.authMs = Date.now() - authStart;

    // Build a fresh model per turn — systemInstruction lives here (not on
    // the per-request body) so the SDK uses its canonical wiring.
    const fnDecls = geminiFunctionDeclarations();
    const model = buildModel(vertexRegion, {
      systemInstruction: { role: "system", parts: [{ text: SYSTEM_PROMPT }] },
      tools: [{ functionDeclarations: fnDecls }],
    });

    let result;
    const vertexCallStart = Date.now();
    try {
      console.log("[agent] generateContentStream", {
        region: vertexRegion,
        bqLocation: wsData?.bqLocation,
        model: gcp.vertexModel,
        project: gcp.projectId,
        turn,
        historyLen: history.length,
        fnDeclsCount: fnDecls.length,
        fnDeclsNames: fnDecls.map((f) => f.name),
      });
      result = await model.generateContentStream({
        contents: history,
        generationConfig: { maxOutputTokens: 4096 },
      });
      turnMetrics.vertexCallMs = Date.now() - vertexCallStart;
    } catch (err) {
      turnMetrics.vertexCallMs = Date.now() - vertexCallStart;
      const props: Record<string, unknown> = {};
      if (err && typeof err === "object") {
        for (const key of Object.getOwnPropertyNames(err)) {
          try {
            const v = (err as Record<string, unknown>)[key];
            if (typeof v !== "function") props[key] = v;
          } catch {
            /* unreadable */
          }
        }
      }
      const chain = flattenErrorChain(err);
      console.error("[agent] generateContentStream threw", {
        region: vertexRegion,
        model: gcp.vertexModel,
        project: gcp.projectId,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        chain,
        stack: err instanceof Error ? err.stack : undefined,
        props,
      });
      const wrapped = new Error(
        `vertex.generateContentStream failed: ${chain}`
      );
      (wrapped as Error & { source?: string }).source = "vertex.generateContentStream";
      throw wrapped;
    }

    // Buffers for this turn — Gemini's streaming yields chunks with
    // candidates[].content.parts[]; functionCalls arrive in full, text
    // in deltas.
    const turnTextParts: string[] = [];
    const turnFunctionCalls: FunctionCall[] = [];

    // The stream iteration itself can throw a SyntaxError if the
    // underlying HTTP response is HTML (model not available in this
    // region, billing not enabled, auth challenged to web UI). Wrap
    // separately so the error tag identifies "stream iteration" not
    // "generateContentStream entry".
    let streamIter;
    try {
      streamIter = result.stream;
    } catch (err) {
      const wrapped = new Error(
        `vertex.stream access failed: ${err instanceof Error ? err.message : String(err)}`
      );
      (wrapped as Error & { source?: string }).source = "vertex.stream.access";
      throw wrapped;
    }

    const streamStart = Date.now();
    try {
      for await (const chunk of streamIter) {
        const candidate = chunk.candidates?.[0] as GenerateContentCandidate | undefined;
        const parts = candidate?.content?.parts;
        if (!parts) continue;

        for (const part of parts) {
          if (part.text) {
            yield { type: "text_delta", text: part.text };
            turnTextParts.push(part.text);
            assistantText.push(part.text);
          } else if (part.functionCall) {
            turnFunctionCalls.push(part.functionCall);
          }
        }

        // Token usage is on the last chunk's usageMetadata. We accumulate
        // — multiple iterations of the agentic loop each add to the total.
        const usage = chunk.usageMetadata;
        if (usage) {
          totalTokensIn += usage.promptTokenCount ?? 0;
          totalTokensOut += usage.candidatesTokenCount ?? 0;
        }
      }
      turnMetrics.streamMs = Date.now() - streamStart;
    } catch (err) {
      turnMetrics.streamMs = Date.now() - streamStart;
      const props: Record<string, unknown> = {};
      if (err && typeof err === "object") {
        for (const key of Object.getOwnPropertyNames(err)) {
          try {
            const v = (err as Record<string, unknown>)[key];
            if (typeof v !== "function") props[key] = v;
          } catch {
            /* unreadable */
          }
        }
      }
      const chain = flattenErrorChain(err);
      console.error("[agent] stream iteration threw", {
        region: vertexRegion,
        model: gcp.vertexModel,
        project: gcp.projectId,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        chain,
        stack: err instanceof Error ? err.stack : undefined,
        props,
      });
      const wrapped = new Error(
        `vertex stream iteration failed: ${chain}`
      );
      (wrapped as Error & { source?: string }).source = "vertex.stream.iterate";
      throw wrapped;
    }

    // Persist this turn's content into history (so the next iteration
    // sees what the model just said).
    const turnParts: Part[] = [];
    if (turnTextParts.length > 0) {
      const text = turnTextParts.join("");
      turnParts.push({ text });
      finalToolBlocks.push({ type: "text", text });
    }
    for (const fc of turnFunctionCalls) {
      turnParts.push({ functionCall: fc });
    }
    if (turnParts.length > 0) {
      history.push({ role: "model", parts: turnParts });
    }

    // ── No function calls → we're done ──────────────────────────
    if (turnFunctionCalls.length === 0) {
      logTurnComplete(turn, turnStart, turnMetrics, false);
      break;
    }

    // ── Execute the function calls ──────────────────────────────
    const fnResultParts: Part[] = [];

    for (const fc of turnFunctionCalls) {
      // Synthesize a tool_use ID — Gemini doesn't issue one but our
      // client UI needs a stable handle to associate the result later.
      const toolUseId = `tu_${Math.random().toString(36).slice(2, 14)}`;
      const fnName = fc.name ?? "";
      const fnArgs = (fc.args ?? {}) as Record<string, unknown>;

      yield {
        type: "tool_use",
        id: toolUseId,
        name: fnName,
        input: fnArgs,
      };

      finalToolBlocks.push({
        type: "tool_use",
        id: toolUseId,
        name: fnName,
        input: fnArgs,
      });

      const toolStart = Date.now();
      let toolOk = true;
      try {
        const result = await executeTool(fnName, fnArgs, ctx);

        if (result.clientRender?.kind === "chart") {
          yield {
            type: "chart",
            id: toolUseId,
            title: result.clientRender.title ?? fnName,
            spec: result.clientRender.spec,
          };
        } else if (result.clientRender?.kind === "table") {
          yield { type: "table", id: toolUseId, rows: result.clientRender.rows };
        } else if (result.clientRender?.kind === "dashboard") {
          yield {
            type: "dashboard",
            id: toolUseId,
            dashboardId: result.clientRender.dashboardId,
            title: result.clientRender.title,
            description: result.clientRender.description,
            charts: result.clientRender.charts,
          };
        }

        yield { type: "tool_result", id: toolUseId, output: result.content };

        fnResultParts.push({
          functionResponse: {
            name: fnName,
            response: result.content as Record<string, unknown>,
          },
        });

        finalToolBlocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result.content,
        });
      } catch (err) {
        toolOk = false;
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "tool_result", id: toolUseId, output: null, error: message };
        fnResultParts.push({
          functionResponse: {
            name: fnName,
            response: { error: message },
          },
        });
        finalToolBlocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: { error: message },
        });
      }
      const toolMs = Date.now() - toolStart;
      turnMetrics.toolsMs += toolMs;
      turnMetrics.toolsExecuted.push({ name: fnName, ms: toolMs, ok: toolOk });
    }

    // Append all function responses as a single "user" turn (Gemini
    // semantics: tool outputs come from the user role, not assistant).
    history.push({ role: "user", parts: fnResultParts });

    logTurnComplete(turn, turnStart, turnMetrics, true);
  }

  console.log("[agent] runAgentTurn complete", {
    turns: turn,
    totalMs: Date.now() - turnStartedAt,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
  });

  yield { type: "message_stop" };

  // ── Persist the full assistant message ──────────────────────────
  // Stringify tool_use.input and tool_result.content before writing to
  // Firestore. Why: Firestore rejects documents containing array-of-array
  // values ("Property array contains an invalid nested entity"). Tool
  // inputs/outputs are model-generated payloads that can include
  // arbitrarily nested shapes (e.g. ECharts series.data was a 2D array
  // before we normalized it to flat numbers + xAxis labels, and the
  // failed-validation case still pushes the original tool_use to
  // toolBlocks). Stringifying the variable-shape fields makes the
  // persisted doc Firestore-safe regardless of what the model emitted.
  // blocksToGeminiTurns / msgContentToGeminiPart parse on replay.
  const persistableToolBlocks = finalToolBlocks.map((b) => {
    if (b.type === "tool_use") {
      return { ...b, input: JSON.stringify(b.input ?? null) };
    }
    if (b.type === "tool_result") {
      return { ...b, content: JSON.stringify(b.content ?? null) };
    }
    return b;
  });
  await assistantMsgRef.set({
    role: "assistant",
    content: assistantText.join(""),
    toolBlocks: persistableToolBlocks,
    createdAt: FieldValue.serverTimestamp(),
  });

  } finally {
    // Fires on normal completion, exception, AND client cancellation
    // (generator.return()). logAgentMessage is itself fire-and-forget so
    // this won't block the cancellation path. Idempotent via usageLogged.
    flushUsage();
  }
}

/**
 * Convert a persisted MsgContent (our internal Anthropic-flavored
 * shape) back into a Gemini Part for re-sending in history. We keep
 * the persisted format consistent across model swaps so old chats
 * remain replayable.
 */
function msgContentToGeminiPart(
  block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: unknown }
): Part {
  if (block.type === "text") return { text: block.text };
  if (block.type === "tool_use") {
    return { functionCall: { name: block.name, args: unwrapJsonField(block.input) } };
  }
  // tool_result — Gemini wraps as functionResponse, no tool_use_id in
  // its shape, we just pass the content.
  return {
    functionResponse: {
      name: "tool_result",
      response: unwrapJsonField(block.content),
    },
  };
}

/**
 * Persisted toolBlocks may have `input`/`content` either as raw objects
 * (legacy / in-memory) or as JSON strings (post-stringification at
 * persist time, see assistantMsgRef.set above). Accept both forms so
 * old chats remain replayable.
 */
function unwrapJsonField(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

/**
 * Split a persisted assistant message's flat block list back into the
 * Content turns Gemini's API expects.
 *
 * Why this matters: during a single runAgentTurn we build history in
 * the correct shape (model turn → user turn for tool_results → model
 * turn → …). But we persist the entire assistant exchange as ONE
 * Firestore doc with `toolBlocks` holding all parts in order. Replaying
 * that as a single Content turn merges function_call and function_response
 * parts, which Gemini rejects with:
 *
 *   "function call turn contains at least one function_call part which
 *    can not be mixed with function_response"
 *
 * We detect role boundaries by part kind:
 *   - text + tool_use  →  {role: "model"} turn
 *   - tool_result      →  {role: "user"} turn (Gemini puts tool outputs
 *                          on the user role, not assistant)
 * and emit a new Content each time the role changes.
 */
function blocksToGeminiTurns(
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: unknown }
  >
): Content[] {
  const turns: Content[] = [];
  let currentRole: "model" | "user" | null = null;
  let currentParts: Part[] = [];

  for (const block of blocks) {
    const targetRole: "model" | "user" =
      block.type === "tool_result" ? "user" : "model";
    if (currentRole !== null && currentRole !== targetRole) {
      turns.push({ role: currentRole, parts: currentParts });
      currentParts = [];
    }
    currentRole = targetRole;
    currentParts.push(msgContentToGeminiPart(block));
  }
  if (currentRole !== null && currentParts.length > 0) {
    turns.push({ role: currentRole, parts: currentParts });
  }
  return turns;
}
