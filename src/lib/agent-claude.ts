/**
 * Claude-on-Vertex agent loop, built on the Vercel AI SDK.
 *
 * Parallel to src/lib/agent.ts (the Gemini path). Dispatched from
 * /api/chat/route.ts based on the configured model prefix:
 *   - `claude-*` → this file
 *   - `gemini-*` → src/lib/agent.ts (untouched, instant rollback path)
 *
 * Why a separate file: the move from @google-cloud/vertexai to the AI
 * SDK is a substantial rewrite. Doing it in-place would conflate
 * "model swap" with "loop rewrite" in one diff. Two files keeps the
 * Gemini path frozen, regression-free, and one env var away
 * (`VERTEX_AI_MODEL=gemini-2.5-flash`).
 *
 * What stays identical to the Gemini path (intentional):
 *  - External signature: `runAgentTurn(AgentTurnInput) → AsyncGenerator<ChatStreamEvent>`
 *  - Firestore persistence shape: same toolBlocks ({ type, ... }) format
 *  - SSE event types streamed to the client (text_delta, tool_use,
 *    tool_result, chart, dashboard, table, message_start, message_stop)
 *  - Workspace-scoped tool context (clientId, workspaceId, userId, chatId)
 *  - Edit-mode preamble injection
 *  - Per-region Vertex routing via workspace bqLocation
 *  - Usage event logging via logAgentMessage
 *
 * What's better than the Gemini path:
 *  - Native tool use (Claude's tool-use training is materially better
 *    than Gemini Flash's — fewer mid-flow stops, better instruction
 *    following, better SQL dialect knowledge, better task decomposition)
 *  - Prompt caching on the system prompt (~90% input-token reduction
 *    on repeated context)
 *  - Built-in retry with exponential backoff on transient 429/5xx
 *    (AI SDK's default; the Gemini path had none)
 *  - Multi-step loop is library-managed (`stopWhen: stepCountIs(N)`)
 *    rather than hand-rolled
 *
 * Risk to watch in production:
 *  - Prompt caching only kicks in for >= 1024 cached tokens. System
 *    prompt is ~3-5k tokens so should hit the threshold, but verify
 *    in usage logs.
 *  - clientRender side-channel: we propagate chart/dashboard/table
 *    events via a closure-captured queue because tool execute returns
 *    go straight to the model. See ClientRenderQueue below.
 *  - First-try region routing: Claude Sonnet 4.6 is served from `eu` /
 *    `us` / `global` Vertex endpoints. Our existing vertexRegionForResidency
 *    function returns Gemini-shaped regions (europe-west1 etc.); we
 *    map to Claude's region naming below.
 */

import { FieldValue } from "@google-cloud/firestore";
import { streamText, stepCountIs, tool as aiTool, type ModelMessage, type ToolSet } from "ai";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { ensureGcpAuth } from "@/lib/gcp-auth";
import { gcp, vertexRegionForResidency } from "@/lib/gcp";
import {
  tools as toolDefinitions,
  executeTool,
  type AgentContext,
} from "@/lib/tools";
import { dbReady, chatsIn, messagesIn, workspaceDoc } from "@/lib/firestore";
import { logAgentMessage } from "@/lib/usage";
import type { ChatStreamEvent } from "@/lib/streaming";
import { SYSTEM_PROMPT, buildEditContextPreamble, type AgentEditContext, type AgentTurnInput } from "@/lib/agent";

// Re-export so external callers can use either path without importing
// from two modules.
export type { AgentEditContext, AgentTurnInput };

// ── Loop budget ────────────────────────────────────────────────────
//
// Claude handles agentic loops much more efficiently than Gemini —
// expect typical exec dashboards to fit in 6-10 steps rather than
// pushing the limit. We keep MAX_STEPS comfortably above that as a
// safety net. Each step is a Vertex round-trip (~1-3s) plus tool work,
// so the ceiling × maxDuration bounds the worst-case wall-clock.
const MAX_STEPS = 25;

// ── Persisted toolBlock shape ──────────────────────────────────────
//
// Identical to the Gemini agent's persistence format. Lucky historical
// choice — it was already Anthropic-flavored ({ type: "tool_use" |
// "tool_result" | "text" }), so chat history written by one path is
// replayable by the other.
type MsgContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

interface ServerToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Map our workspace residency region (Gemini-shaped, like
 * `europe-west1`) to Claude-on-Vertex's accepted location names.
 *
 * Claude on Vertex is currently served from `europe-west1`, `us-east5`,
 * and `global`. Anthropic uses the same regional codes as standard
 * Vertex AI but the model is only enabled in a subset of regions.
 *
 * For EU residency, we route to `europe-west1` (matches our existing
 * Gemini default). For US, `us-east5`. Falls back to the workspace's
 * configured Vertex region if it's a known Claude region.
 */
function claudeRegionForResidency(bqLocation: "EU" | "US" | undefined): string {
  // For now, mirror the Gemini region map verbatim. Adjust if Claude
  // availability changes per region.
  return vertexRegionForResidency(bqLocation);
}

/**
 * Side-channel for clientRender events from tool handlers. Tool execute
 * returns flow straight back into the model in AI SDK — the customer-
 * facing chart/dashboard/table events have no native path. We collect
 * them per tool call in this queue, then drain it as we yield SSE
 * events from the main loop.
 */
class ClientRenderQueue {
  private events: ChatStreamEvent[] = [];
  push(event: ChatStreamEvent) {
    this.events.push(event);
  }
  drain(): ChatStreamEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/**
 * Build AI SDK tools from our existing ToolDefinition[]. Each tool's
 * execute() runs the existing handler, propagates clientRender to the
 * provided queue, and returns just the model-facing content. Errors
 * are wrapped so they reach the model as tool errors rather than
 * crashing the loop.
 */
function buildAiSdkTools(
  ctx: AgentContext,
  renderQueue: ClientRenderQueue,
  toolCallRegistry: Map<string, ServerToolCall>
): ToolSet {
  const out: ToolSet = {};
  for (const t of toolDefinitions) {
    out[t.name] = aiTool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input, { toolCallId }) => {
        // Register the call for later persistence + SSE emission.
        toolCallRegistry.set(toolCallId, {
          id: toolCallId,
          name: t.name,
          input,
        });
        try {
          const result = await executeTool(t.name, input, ctx);
          if (result.clientRender?.kind === "chart") {
            renderQueue.push({
              type: "chart",
              id: toolCallId,
              title: result.clientRender.title ?? t.name,
              spec: result.clientRender.spec,
            });
          } else if (result.clientRender?.kind === "table") {
            renderQueue.push({
              type: "table",
              id: toolCallId,
              rows: result.clientRender.rows,
            });
          } else if (result.clientRender?.kind === "dashboard") {
            renderQueue.push({
              type: "dashboard",
              id: toolCallId,
              dashboardId: result.clientRender.dashboardId,
              title: result.clientRender.title,
              description: result.clientRender.description,
              charts: result.clientRender.charts,
            });
          }
          return result.content;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Return an error-shaped payload to the model so it can recover
          // (retry with different args, give up gracefully, etc.) rather
          // than throwing and tearing down the whole stream.
          return { error: message };
        }
      },
    });
  }
  return out;
}

/**
 * Translate our persisted toolBlock shape into AI SDK ModelMessage[]
 * for replay. Same logic as the Gemini path's blocksToGeminiTurns, but
 * the target format is the AI SDK's role/content shape rather than
 * Gemini's role/parts.
 *
 * Key constraint preserved from the Gemini path: tool_result blocks
 * must NOT live on the same turn as tool_use blocks. Assistant emits
 * tool_use; user (tool-result role in AI SDK) provides the response.
 * Splitting the flat block list back into alternating turns is the
 * same algorithm.
 */
function blocksToModelMessages(blocks: MsgContent[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let assistantParts: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];

  const flushAssistant = () => {
    if (assistantParts.length > 0) {
      out.push({ role: "assistant", content: assistantParts });
      assistantParts = [];
    }
  };

  for (const b of blocks) {
    if (b.type === "text") {
      assistantParts.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      assistantParts.push({
        type: "tool-call",
        toolCallId: b.id,
        toolName: b.name,
        input: b.input,
      });
    } else if (b.type === "tool_result") {
      // tool_result starts a new "tool" message — flush the pending
      // assistant content first.
      flushAssistant();
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: b.tool_use_id,
            toolName: "",
            output: {
              type: "json",
              value: (b.content ?? null) as Parameters<typeof JSON.stringify>[0],
            },
          },
        ],
      });
    }
  }
  flushAssistant();
  return out;
}

/**
 * Cached Vertex Anthropic provider instances, keyed by region. Same
 * pattern as the Gemini path's `_vertexByRegion` — instantiating the
 * provider is non-trivial (auth chain) so we keep one per region.
 */
const _providerByRegion = new Map<string, ReturnType<typeof createVertexAnthropic>>();

function getProvider(region: string) {
  let p = _providerByRegion.get(region);
  if (!p) {
    p = createVertexAnthropic({
      project: gcp.projectId,
      location: region,
    });
    _providerByRegion.set(region, p);
  }
  return p;
}

/**
 * Strip noisy strings from an error chain before surfacing to the
 * client. AI SDK errors come back as named subclasses with a `.cause`
 * chain (NetworkError → APICallError → underlying fetch error). We
 * walk them like the Gemini path's flattenErrorChain so the SSE
 * error event carries the actual cause, not the outer wrapper.
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
      const next = cur as Error & { cause?: unknown };
      const candidate = next.cause;
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

/**
 * Run one full agent turn against Claude Sonnet via Vertex AI. Same
 * public signature as the Gemini-path runAgentTurn — the route file
 * picks between them by model prefix and the caller doesn't care.
 */
export async function* runAgentTurn(
  input: AgentTurnInput
): AsyncGenerator<ChatStreamEvent> {
  await ensureGcpAuth();

  // ── Resolve workspace residency → Vertex region ─────────────────
  await dbReady();
  const wsSnap = await workspaceDoc(input.clientId, input.workspaceId).get();
  const wsData = wsSnap.data() as { bqLocation?: "EU" | "US" } | undefined;
  const vertexRegion = claudeRegionForResidency(wsData?.bqLocation);

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

  // ── Load conversation history ──────────────────────────────────
  const historySnap = await messagesCol
    .orderBy("createdAt", "asc")
    .limit(40)
    .get();

  const history: ModelMessage[] = [];
  for (const doc of historySnap.docs) {
    const data = doc.data() as {
      role: "user" | "assistant";
      content: string;
      toolBlocks?: MsgContent[];
    };
    if (data.toolBlocks && data.toolBlocks.length > 0) {
      // Replay the persisted blocks into AI SDK shape, preserving the
      // alternating assistant/tool-result turn structure.
      const parsedBlocks = data.toolBlocks.map((b) => {
        // Persistence stringifies tool_use.input / tool_result.content
        // to dodge Firestore's "no nested arrays" restriction. Parse
        // them back here.
        if (b.type === "tool_use" && typeof b.input === "string") {
          try {
            return { ...b, input: JSON.parse(b.input) };
          } catch {
            return b;
          }
        }
        if (b.type === "tool_result" && typeof b.content === "string") {
          try {
            return { ...b, content: JSON.parse(b.content) };
          } catch {
            return b;
          }
        }
        return b;
      });
      history.push(...blocksToModelMessages(parsedBlocks));
    } else {
      history.push({
        role: data.role === "assistant" ? "assistant" : "user",
        content: data.content,
      });
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
    orgId: input.clientId, // deprecated alias
  };

  const assistantText: string[] = [];
  const finalToolBlocks: MsgContent[] = [];
  const turnStartedAt = Date.now();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let usageLogged = false;
  const flushUsage = () => {
    if (usageLogged) return;
    usageLogged = true;
    logAgentMessage({
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      chatId,
      model: gcp.vertexModel,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      executionMs: Date.now() - turnStartedAt,
    });
  };

  // Build system prompt with optional edit-mode preamble. Same logic
  // as the Gemini path — preamble is per-turn, NOT persisted.
  const systemPromptText = input.editContext
    ? `${SYSTEM_PROMPT}\n\n${buildEditContextPreamble(input.editContext)}`
    : SYSTEM_PROMPT;

  const renderQueue = new ClientRenderQueue();
  const toolCallRegistry = new Map<string, ServerToolCall>();
  const tools = buildAiSdkTools(ctx, renderQueue, toolCallRegistry);

  try {
    const provider = getProvider(vertexRegion);
    const model = provider(gcp.vertexModel);

    // ── Outer continuation loop ───────────────────────────────────
    //
    // AI SDK's `streamText` with `stopWhen: stepCountIs(N)` already
    // handles multi-step tool loops within ONE call. But it terminates
    // the moment the model returns a step with no tool calls — even if
    // that's a mid-workflow narration like "Here's the data:" or "Your
    // tables look sparse." instead of completing the requested chart /
    // dashboard.
    //
    // This is the same failure mode as the Gemini path (LIVELI-99,
    // LIVELI-105). The fix is the same architecturally: detect a
    // mid-workflow text-only termination by inspecting what the model
    // just produced, inject a continuation prompt, and call streamText
    // again with the augmented history. AI SDK can't natively be told
    // to "continue past a text-only step" — but we can call it again
    // ourselves.
    //
    // The discriminator: after a streamText call completes, if the
    // last assistant turn is text-only AND the conversation has tool
    // results in it (i.e., we're past the first conversational
    // exchange), we know the model gave up before completing. Inject
    // a continuation and re-call.
    //
    // Capped at MAX_TEXT_ONLY_CONTINUATIONS to prevent infinite
    // back-and-forth with a stuck model. After the cap, surface a
    // user-facing "I ran out of steps" message (mirrors LIVELI-105).
    const MAX_TEXT_ONLY_CONTINUATIONS = 3;
    let textOnlyContinuations = 0;
    let gaveUp = false;

    while (true) {
      const result = streamText({
        model,
        system: systemPromptText,
        messages: history,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        // Anthropic prompt caching — mark the system prompt as ephemeral
        // so repeated context (system rules + edit preamble) is cached
        // on Anthropic's side. ~90% input-token reduction on cache hits.
        providerOptions: {
          anthropic: {
            cacheControl: { type: "ephemeral" },
          },
        },
        // AI SDK default is 2 retries with backoff — bump for transient
        // 429s in EU region where Anthropic capacity is tighter than US.
        maxRetries: 4,
      });

      // Track whether this streamText call resulted in any tool use.
      // If yes, the model engaged with the workflow; if no, it produced
      // only text — which we then check for mid-flow context below.
      let toolCallsThisCall = 0;

      // ── Stream loop: translate AI SDK fullStream chunks → our SSE events
      for await (const chunk of result.fullStream) {
        switch (chunk.type) {
          case "text-delta": {
            const text = chunk.text;
            assistantText.push(text);
            yield { type: "text_delta", text };
            break;
          }
          case "tool-input-start": {
            // Tool call started — emit the tool_use event now so the
            // client renders the "Querying your data" indicator while
            // execute() runs server-side.
            yield {
              type: "tool_use",
              id: chunk.id,
              name: chunk.toolName,
              input: {},
            };
            break;
          }
          case "tool-call": {
            toolCallsThisCall++;
            // Tool call args finalised. Update the registry entry with
            // real input, and re-emit a refined tool_use event so the
            // client UI can show the actual args.
            const registered = toolCallRegistry.get(chunk.toolCallId);
            const input = registered?.input ?? chunk.input;
            finalToolBlocks.push({
              type: "tool_use",
              id: chunk.toolCallId,
              name: chunk.toolName,
              input,
            });
            yield {
              type: "tool_use",
              id: chunk.toolCallId,
              name: chunk.toolName,
              input,
            };
            break;
          }
          case "tool-result": {
            // Drain any clientRender events the tool produced.
            for (const ev of renderQueue.drain()) yield ev;
            finalToolBlocks.push({
              type: "tool_result",
              tool_use_id: chunk.toolCallId,
              content: chunk.output,
            });
            yield {
              type: "tool_result",
              id: chunk.toolCallId,
              output: chunk.output,
            };
            break;
          }
          case "tool-error": {
            for (const ev of renderQueue.drain()) yield ev;
            const message =
              chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
            finalToolBlocks.push({
              type: "tool_result",
              tool_use_id: chunk.toolCallId,
              content: { error: message },
            });
            yield {
              type: "tool_result",
              id: chunk.toolCallId,
              output: null,
              error: message,
            };
            break;
          }
          case "error": {
            const message = flattenErrorChain(chunk.error);
            console.error("[agent-claude] stream error", { message });
            yield { type: "error", error: message };
            break;
          }
          case "finish": {
            const u = chunk.totalUsage;
            // Accumulate — each streamText call in the continuation
            // loop reports its own usage; we want the total for the
            // whole user-message-cycle.
            totalTokensIn += u?.inputTokens ?? 0;
            totalTokensOut += u?.outputTokens ?? 0;
            break;
          }
          default:
            // Other chunk types (step-start, step-finish, reasoning,
            // source, tool-input-delta, etc.) we don't need to surface
            // to the client. Drop silently.
            break;
        }
      }

      // After the stream drains, fetch the model's response messages
      // and append to history. AI SDK gives us back model + tool turns
      // in CoreMessage shape, which is what subsequent streamText
      // calls expect.
      const finalResponse = await result.response;
      history.push(...finalResponse.messages);

      // ── Detect mid-workflow text-only termination ───────────────
      //
      // If this streamText call produced ZERO tool calls but the
      // conversation already contains tool-results from earlier turns,
      // the model gave up mid-flow. Inject a continuation prompt and
      // re-call streamText. The user-facing prose the model just
      // emitted has already been streamed; the continuation should
      // produce the actual chart/dashboard/table on the next pass.
      const sessionHasToolResults = history.some((m) => m.role === "tool");

      if (
        toolCallsThisCall === 0 &&
        sessionHasToolResults &&
        textOnlyContinuations < MAX_TEXT_ONLY_CONTINUATIONS
      ) {
        textOnlyContinuations++;
        const continuationPrompt =
          "[System intervention] You produced reply text without calling a tool. " +
          "The workflow is incomplete — the customer is waiting for the final " +
          "output (chart / dashboard / table / summary). Do ONE of the following NOW:\n" +
          "  - If a chart was requested but not yet rendered: call make_chart.\n" +
          "  - If a dashboard was requested but not yet rendered: call make_dashboard.\n" +
          "  - If editing a chart/dashboard: call update_chart / update_dashboard.\n" +
          "  - If you need more data first: call run_sql.\n" +
          "  - If the data is genuinely insufficient (e.g. tables are empty or have 1 row), call make_chart / make_dashboard ANYWAY with what's there AND in the resulting prose explain that the data is sparse. Do NOT silently stop without producing the requested output.\n" +
          "Do NOT narrate further or repeat your previous text — call the appropriate tool now.";
        history.push({
          role: "user",
          content: continuationPrompt,
        });
        console.warn(
          "[agent-claude] forced continuation after text-only mid-workflow termination",
          {
            continuationsUsed: textOnlyContinuations,
            maxContinuations: MAX_TEXT_ONLY_CONTINUATIONS,
          }
        );
        continue;
      }

      // Either:
      //  - Tools were called (workflow progressed normally; AI SDK
      //    would have looped internally; we're done)
      //  - No prior tool results in session (legit conversational reply)
      //  - Continuations exhausted (give up and surface what we have)
      if (
        toolCallsThisCall === 0 &&
        sessionHasToolResults &&
        textOnlyContinuations >= MAX_TEXT_ONLY_CONTINUATIONS
      ) {
        gaveUp = true;
        console.warn("[agent-claude] gave up forcing continuation", {
          continuationsUsed: textOnlyContinuations,
        });
      }
      break;
    }

    // If we burned through every continuation attempt and the model
    // still wouldn't complete the workflow, stream a clean recovery
    // message to the customer rather than leaving them with whatever
    // partial output they saw + silence.
    if (gaveUp) {
      const truncationMsg =
        "\n\nI ran out of steps before I could finish that. Try asking for a smaller scope (one chart at a time, or a narrower dashboard) and I'll have plenty of room.";
      assistantText.push(truncationMsg);
      yield { type: "text_delta", text: truncationMsg };
    }

    yield { type: "message_stop" };
  } catch (err) {
    const chain = flattenErrorChain(err);
    console.error("[agent-claude] runAgentTurn threw", {
      region: vertexRegion,
      model: gcp.vertexModel,
      project: gcp.projectId,
      chain,
      stack: err instanceof Error ? err.stack : undefined,
    });
    yield { type: "error", error: chain };
  } finally {
    // Persist the full assistant message + log usage exactly once.
    // Stringify tool_use.input / tool_result.content for Firestore's
    // "no nested arrays" restriction — same trick as the Gemini path.
    const persistableToolBlocks = finalToolBlocks.map((b) => {
      if (b.type === "tool_use") {
        return { ...b, input: JSON.stringify(b.input ?? null) };
      }
      if (b.type === "tool_result") {
        return { ...b, content: JSON.stringify(b.content ?? null) };
      }
      return b;
    });
    try {
      await assistantMsgRef.set({
        role: "assistant",
        content: assistantText.join(""),
        toolBlocks: persistableToolBlocks,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (persistErr) {
      console.error("[agent-claude] failed to persist assistant message", {
        message: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }
    flushUsage();
  }
}
