import { FieldValue } from "@google-cloud/firestore";
import type {
  Content,
  FunctionCall,
  GenerateContentCandidate,
  Part,
} from "@google-cloud/vertexai";
import { buildModel, vertexReady, MODEL } from "@/lib/vertex";
import { ensureGcpAuth } from "@/lib/gcp-auth";
import { gcp } from "@/lib/gcp";
import {
  executeTool,
  geminiFunctionDeclarations,
  type AgentContext,
} from "@/lib/tools";
import { dbReady, chatsIn, messagesIn } from "@/lib/firestore";
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
- Each connector has its own BigQuery dataset (named like \`c_<id>__w_<id>__d_<connectorId>\`). The \`list_tables\` response gives you a \`dataset\` field per table — use it to **fully qualify** every table in your SQL: \`SELECT * FROM \\\`dataset.table\\\`\`.
- Wrap fully-qualified names in backticks because dataset names contain underscores BigQuery's parser can be picky about.
- If the user asks about "their data" without specifying a source, query across all relevant connectors' datasets (UNION ALL where the schema matches, or describe what each source has).
- READ-ONLY queries only: SELECT and WITH allowed. Never DDL, UPDATE, DELETE, INSERT, MERGE.
- Keep queries efficient: aggregate, filter, LIMIT. The dataset has a 10 GB scan cap.
- For charts: pick the right type (bar for ranking, line for time series, pie for share-of-total, scatter for correlation). Always set a title.
- Write conversationally. Don't say "I will now call the run_sql tool" — just call it and present the result.
- If the result is empty or unexpected, say so plainly.
- Use the current date for any "last quarter / this month / YTD" references.

Current date: ${new Date().toISOString().split("T")[0]}.`;

// Max agent turns per user message — prevents infinite tool loops.
const MAX_TURNS = 8;

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

  // ── Open or create the chat ────────────────────────────────────
  await dbReady();
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
      const parts: Part[] = data.toolBlocks.map((b) => msgContentToGeminiPart(b));
      history.push({ role, parts });
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

  // ── Agentic loop ────────────────────────────────────────────────
  let turn = 0;
  while (turn < MAX_TURNS) {
    turn++;

    // Wrap each external call with tagged try/catch so failures
    // surface their actual source.
    try {
      await vertexReady(); // ensures ADC is written before the SDK reads it
    } catch (err) {
      const wrapped = new Error(
        `vertexReady failed (auth/ADC): ${err instanceof Error ? err.message : String(err)}`
      );
      (wrapped as Error & { source?: string }).source = "vertexReady";
      throw wrapped;
    }

    // Build a fresh model per turn — systemInstruction lives here (not on
    // the per-request body) so the SDK uses its canonical wiring.
    const fnDecls = geminiFunctionDeclarations();
    const model = buildModel({
      systemInstruction: { role: "system", parts: [{ text: SYSTEM_PROMPT }] },
      tools: [{ functionDeclarations: fnDecls }],
    });

    let result;
    try {
      console.log("[agent] generateContentStream", {
        region: gcp.vertexRegion,
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
    } catch (err) {
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
      console.error("[agent] generateContentStream threw", {
        region: gcp.vertexRegion,
        model: gcp.vertexModel,
        project: gcp.projectId,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        props,
      });
      const wrapped = new Error(
        `vertex.generateContentStream failed: ${err instanceof Error ? err.message : String(err)}`
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
    } catch (err) {
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
      console.error("[agent] stream iteration threw", {
        region: gcp.vertexRegion,
        model: gcp.vertexModel,
        project: gcp.projectId,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        props,
      });
      const wrapped = new Error(
        `vertex stream iteration failed: ${err instanceof Error ? err.message : String(err)}`
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
    if (turnFunctionCalls.length === 0) break;

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
    }

    // Append all function responses as a single "user" turn (Gemini
    // semantics: tool outputs come from the user role, not assistant).
    history.push({ role: "user", parts: fnResultParts });
  }

  yield { type: "message_stop" };

  // ── Log usage event (fire-and-forget) ───────────────────────────
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

  // ── Persist the full assistant message ──────────────────────────
  await assistantMsgRef.set({
    role: "assistant",
    content: assistantText.join(""),
    toolBlocks: finalToolBlocks,
    createdAt: FieldValue.serverTimestamp(),
  });
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
    return { functionCall: { name: block.name, args: block.input as Record<string, unknown> } };
  }
  // tool_result — but the model wraps these as functionResponse, with no
  // tool_use_id in the Gemini shape. We just pass the content.
  return {
    functionResponse: {
      name: "tool_result",
      response: block.content as Record<string, unknown>,
    },
  };
}
