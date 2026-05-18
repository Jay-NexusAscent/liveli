import { FieldValue } from "@google-cloud/firestore";
import { vertexReady, MODEL } from "@/lib/vertex";
import { ensureGcpAuth } from "@/lib/gcp-auth";
import { anthropicToolSpecs, executeTool, type AgentContext } from "@/lib/tools";
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
 * Run one full agent turn: stream tokens from Claude, dispatch any tool
 * calls server-side, append their results to the conversation, and
 * continue until the model emits `end_turn`. Persists user + assistant
 * messages to Firestore under workspaces/{orgId}/chats/{chatId}/messages.
 */
export async function* runAgentTurn(input: AgentTurnInput): AsyncGenerator<ChatStreamEvent> {
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

  // ── Load conversation history (up to last 20 messages) ─────────
  const historySnap = await messagesCol
    .orderBy("createdAt", "asc")
    .limit(40)
    .get();

  type MsgContent =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: unknown };

  const history: Array<{ role: "user" | "assistant"; content: string | MsgContent[] }> = [];

  for (const doc of historySnap.docs) {
    const data = doc.data() as {
      role: "user" | "assistant";
      content: string;
      toolBlocks?: MsgContent[];
    };
    if (data.toolBlocks && data.toolBlocks.length > 0) {
      history.push({ role: data.role, content: data.toolBlocks });
    } else {
      history.push({ role: data.role, content: data.content });
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

  // ── Agentic loop: stream → tool calls → re-stream ──────────────
  let turn = 0;
  let stopReason: string | null = null;

  while (turn < MAX_TURNS) {
    turn++;

    const client = await vertexReady();
    type StreamParams = Parameters<typeof client.messages.stream>[0];
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: anthropicToolSpecs() as unknown as StreamParams["tools"],
      messages: history as unknown as StreamParams["messages"],
    });

    const pendingToolUses: { id: string; name: string; jsonAcc: string }[] = [];
    const turnBlocks: MsgContent[] = [];
    let activeBlockIndex: number | null = null;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "text") {
          activeBlockIndex = event.index;
          turnBlocks[event.index] = { type: "text", text: "" };
        } else if (block.type === "tool_use") {
          activeBlockIndex = event.index;
          pendingToolUses.push({ id: block.id, name: block.name, jsonAcc: "" });
          turnBlocks[event.index] = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          };
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text };
          const block = turnBlocks[event.index];
          if (block?.type === "text") block.text += delta.text;
          assistantText.push(delta.text);
        } else if (delta.type === "input_json_delta") {
          // Accumulate partial JSON for the most recent tool_use
          const tool = pendingToolUses[pendingToolUses.length - 1];
          if (tool) tool.jsonAcc += delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const block = turnBlocks[event.index];
        if (block?.type === "tool_use") {
          const tool = pendingToolUses.find((t) => t.id === block.id);
          if (tool) {
            try {
              block.input = tool.jsonAcc ? JSON.parse(tool.jsonAcc) : {};
            } catch {
              block.input = {};
            }
          }
        }
        activeBlockIndex = null;
      } else if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason ?? null;
        // Anthropic emits cumulative usage on message_delta. We add
        // ALL turns together — a single user message can drive 2-8
        // model turns when tool use is involved, and customers pay
        // for every token across all of them.
        const usage = (event as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        if (usage) {
          totalTokensIn += usage.input_tokens ?? 0;
          totalTokensOut += usage.output_tokens ?? 0;
        }
      }
    }

    // Persist the assistant turn's content blocks into history
    finalToolBlocks.push(...turnBlocks.filter(Boolean));
    history.push({ role: "assistant", content: turnBlocks.filter(Boolean) });

    // ── Did the model request tools? Execute them ────────────────
    const toolUseBlocks = turnBlocks.filter(
      (b): b is Extract<MsgContent, { type: "tool_use" }> => b?.type === "tool_use"
    );

    if (stopReason !== "tool_use" || toolUseBlocks.length === 0) {
      // No more tools — done with this turn
      break;
    }

    const toolResults: MsgContent[] = [];

    for (const block of toolUseBlocks) {
      yield { type: "tool_use", id: block.id, name: block.name, input: block.input };

      try {
        const result = await executeTool(block.name, block.input, ctx);

        // Emit client render hints for inline chart/table display
        if (result.clientRender?.kind === "chart") {
          yield {
            type: "chart",
            id: block.id,
            title: result.clientRender.title ?? block.name,
            spec: result.clientRender.spec,
          };
        } else if (result.clientRender?.kind === "table") {
          yield { type: "table", id: block.id, rows: result.clientRender.rows };
        }

        yield { type: "tool_result", id: block.id, output: result.content };

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result.content),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "tool_result", id: block.id, output: null, error: message };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ error: message }),
        });
      }
    }

    // Append tool results as a new user-role turn (the standard Anthropic pattern)
    history.push({ role: "user", content: toolResults });
  }

  yield { type: "message_stop" };

  // ── Log usage event (fire-and-forget — never blocks user) ─────
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

  // ── Persist the full assistant message ────────────────────────
  await assistantMsgRef.set({
    role: "assistant",
    content: assistantText.join(""),
    toolBlocks: finalToolBlocks,
    createdAt: FieldValue.serverTimestamp(),
  });
}
