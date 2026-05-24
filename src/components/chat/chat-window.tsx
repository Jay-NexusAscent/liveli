"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CloseIcon, PencilIcon, SparkleIcon } from "@/components/icons";
import { ChartBlock } from "./chart-block";
import { ToolCallBlock } from "./tool-call-block";
import { TableBlock } from "./table-block";
import { DashboardBlock } from "./dashboard-block";
import { InsightProposalsBlock } from "./insight-proposals-block";
import type { ColSpan } from "@/lib/dashboards/types";

type DashboardChart = {
  order: number;
  title: string;
  spec: unknown;
  // Per-tile width on the dashboard grid. Threaded through so the
  // inline preview shown after make_dashboard matches the
  // /dashboards rendering exactly.
  colSpan?: ColSpan;
};

type MessageBlock =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      status: "running" | "done" | "error";
      input?: unknown;
      output?: unknown;
      error?: string;
    }
  | { type: "chart"; id: string; title: string; spec: unknown }
  | { type: "table"; id: string; rows: Record<string, unknown>[] }
  | {
      type: "dashboard";
      id: string;
      dashboardId: string;
      title: string;
      description?: string;
      charts: DashboardChart[];
    }
  | {
      // propose_insights — inline cards with Save buttons per
      // proposal. Saving is page-load-scoped state in the block
      // component (no need to persist save status to Firestore).
      type: "insight-proposals";
      id: string;
      proposals: ChatInsightProposal[];
    };

/**
 * Local mirror of InsightProposal from @/lib/streaming. Importing the
 * full module into the chat window pulls more than we need into the
 * client bundle; declaring the shape locally keeps it tight. Must
 * stay in sync with InsightProposal — typed import from streaming.ts
 * verifies that at compile time via the cast in applyEvent.
 */
interface ChatInsightProposal {
  title: string;
  description: string;
  category: "Sales" | "Customer" | "Operational" | "Growth";
  sourceSql: string;
  sourceConnector?: string;
  ruleType: "change_pct_above" | "change_pct_below" | "value_above" | "value_below";
  threshold: number;
  prefill: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  blocks: MessageBlock[];
}

const PROMPT_SUGGESTIONS = [
  "What were our top 5 products by revenue last quarter?",
  "Show weekly new users for the last 90 days",
  "Which countries drive the highest order value?",
  "Build me a dashboard with sales overview",
];

/**
 * Edit-context shape carried in sessionStorage["liveli.editing"] when
 * the user clicks Edit on a saved chart or dashboard. Each chat-API
 * call forwards this so the server-side agent injects an EDIT MODE
 * preamble into the system prompt for that turn and the model calls
 * update_chart / update_dashboard with the supplied id.
 */
interface EditContext {
  kind: "chart" | "dashboard";
  id: string;
  title: string;
  spec?: unknown;
  description?: string | null;
  charts?: Array<{ order?: number; title: string; spec: unknown }>;
}

export function ChatWindow({ initialChatId }: { initialChatId?: string } = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);
  // Prefill from sessionStorage — used by the /insights "Query further"
  // CTAs to drop the user into chat with a starter question ready.
  // sessionStorage (not a URL param) is the right channel here for two
  // reasons:
  //   1) URL stays clean — no stale prefill text in the address bar.
  //   2) Survives React Strict Mode's double-mount in dev. URL-based
  //      one-shot consumption is destructive: the second mount sees the
  //      already-stripped URL and can't repopulate state. sessionStorage
  //      remains readable until we explicitly clear it on send.
  //
  // Read via a lazy useState initialiser (not useEffect + setState):
  // useState's lazy init runs on first render with `window` available
  // on the client, so we can read sessionStorage directly without a
  // setState-in-effect. The textarea below uses suppressHydrationWarning
  // to tolerate the (intentional) server-empty / client-prefilled
  // value divergence — the prefill is one-shot ephemeral state set by
  // a client-side nav from /insights, never present at SSR time in
  // practice.
  const [input, setInput] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem("liveli.chatPrefill") ?? "";
  });
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(!!initialChatId);
  const [datasetNames, setDatasetNames] = useState<Record<string, string>>({});
  // Edit mode: when set, we render a banner above the chat and pass
  // this through with each /api/chat call so the agent uses update_X
  // tools instead of make_X. Persisted in sessionStorage until the
  // user explicitly closes it or starts a new chat.
  //
  // Same lazy-init pattern as `input` above — read sessionStorage at
  // first render, no setState-in-effect.
  const [editContext, setEditContext] = useState<EditContext | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem("liveli.editing");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as EditContext;
      if (parsed.kind && parsed.id && parsed.title) return parsed;
    } catch {
      // Don't sessionStorage.removeItem here — React StrictMode
      // double-invokes lazy initialisers in development, and a
      // removeItem on the second invocation would lose the value
      // before the first commit. Cleanup of malformed entries
      // happens lazily via stopEditing() below.
    }
    return null;
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const stopEditing = () => {
    setEditContext(null);
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("liveli.editing");
    }
  };

  // Fetch the workspace's connectors once and build the dataset→friendly
  // name map. We don't block render on this — if the fetch is slow or
  // fails, SQL falls back to showing the raw dataset IDs (current
  // behaviour, ugly but functional).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/connectors");
        if (!res.ok) return;
        const json = (await res.json()) as { items?: Array<{ bqDataset?: string; name?: string }> };
        const map: Record<string, string> = {};
        for (const c of json.items ?? []) {
          if (c.bqDataset && c.name) map[c.bqDataset] = c.name;
        }
        setDatasetNames(map);
      } catch {
        // ignore — UI just shows raw dataset IDs
      }
    })();
  }, []);

  // Resume mode: load past messages for an existing chat and rebuild
  // the UI's MessageBlock tree from the persisted Firestore toolBlocks.
  // tool_use.input and tool_result.content are JSON-stringified at
  // persist time (see agent.ts) — we parse + reconstruct chart / table
  // / dashboard blocks here so a customer who opens an old chat sees
  // exactly what they saw the first time.
  useEffect(() => {
    if (!initialChatId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chats/${initialChatId}/messages`);
        if (!res.ok) {
          // 404 → chat doesn't exist (deleted, or cross-tenant). Start fresh.
          if (res.status === 404) {
            if (!cancelled) setLoadingHistory(false);
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          chat: { id: string; title: string };
          messages: PersistedMessage[];
        };
        if (cancelled) return;
        setMessages(reconstructMessages(json.messages));
        setChatId(json.chat.id);
      } catch (err) {
        if (cancelled) return;
        setMessages([
          {
            id: "history-error",
            role: "assistant",
            blocks: [
              {
                type: "text",
                text: `_Couldn't load this chat's history: ${err instanceof Error ? err.message : String(err)}_`,
              },
            ],
          },
        ]);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialChatId]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || streaming) return;

    // Consume the Insights prefill — clear so it doesn't refill on
    // refresh or next visit. Safe to call when there was no prefill.
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("liveli.chatPrefill");
    }

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      blocks: [{ type: "text", text }],
    };

    const assistantId = `assistant-${Date.now()}`;
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      blocks: [],
    };

    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput("");
    setStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          chatId,
          editContext: editContext ?? undefined,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Process complete SSE events (terminated by \n\n)
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 2);
          if (!raw.startsWith("data:")) continue;
          const payload = raw.slice(5).trim();
          if (!payload) continue;

          try {
            const event = JSON.parse(payload);
            applyEvent(assistantId, event, setMessages, setChatId);
          } catch {
            // skip malformed event
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((m) =>
        m.map((x) =>
          x.id === assistantId
            ? {
                ...x,
                blocks: [...x.blocks, { type: "text", text: `\n\n_Error: ${msg}_` }],
              }
            : x
        )
      );
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col lg:h-screen">
      {/* suppressHydrationWarning: editContext is read from sessionStorage
          via a lazy useState initialiser, so the banner may render on
          the client but not on the server. The mismatch is intentional
          and confined to whether this banner exists or not. */}
      <div suppressHydrationWarning>
        {editContext && <EditBanner ctx={editContext} onStop={stopEditing} />}
      </div>
      {/* Scrollable message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {loadingHistory ? (
            <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Loading chat history…
            </div>
          ) : messages.length === 0 ? (
            <EmptyState onPick={sendMessage} />
          ) : (
            <div className="space-y-6">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  chatId={chatId}
                  datasetNames={datasetNames}
                />
              ))}
              {streaming && (
                <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  thinking…
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border bg-elevated">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            className="card flex items-center gap-3 p-3"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                streaming ? "Liveli is thinking…" : "Ask a question or describe a chart…"
              }
              disabled={streaming}
              // input is seeded from sessionStorage via lazy useState
              // initialiser, so SSR may render "" while the client
              // hydrates with a prefill. Tolerate that mismatch — the
              // prefill is by definition client-side-only ephemeral
              // state from /insights "Query further".
              suppressHydrationWarning
              className="flex-1 bg-transparent text-[15px] text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={streaming || !input.trim()}
              className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-text-inverted transition-opacity disabled:opacity-50"
            >
              Send
            </button>
          </form>
          <p className="mt-2 text-center text-[11px] text-text-tertiary">
            Connect a source on the Connections tab if you haven&apos;t already.
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-muted text-accent">
        <SparkleIcon className="h-7 w-7" />
      </div>
      <h1 className="text-[32px] font-semibold tracking-tight text-text-primary font-heading">
        Ask anything about your data.
      </h1>
      <p className="mt-3 max-w-md text-[15px] text-text-secondary">
        Liveli writes the SQL, runs it on your warehouse, and explains the answer with
        a chart.
      </p>

      <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
        {PROMPT_SUGGESTIONS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="card cursor-pointer p-3 text-left text-[13px] text-text-secondary transition-colors hover:text-text-primary"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageItem({
  message,
  chatId,
  datasetNames,
}: {
  message: Message;
  chatId?: string;
  datasetNames?: Record<string, string>;
}) {
  if (message.role === "user") {
    const text = message.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    return (
      <div className="flex justify-end">
        <div className="card-elevated max-w-[80%] rounded-2xl px-4 py-2.5 text-[14px] text-text-primary">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {message.blocks.map((b, i) => {
        if (b.type === "text") {
          return <AssistantText key={i} text={b.text} />;
        }
        if (b.type === "tool") {
          return (
            <ToolCallBlock
              key={i}
              name={b.name}
              status={b.status}
              input={b.input}
              output={b.output}
              error={b.error}
              datasetNames={datasetNames}
            />
          );
        }
        if (b.type === "chart") {
          return (
            <ChartBlock
              key={i}
              toolId={b.id}
              title={b.title}
              spec={b.spec}
              chatId={chatId}
            />
          );
        }
        if (b.type === "table") {
          return <TableBlock key={i} rows={b.rows} />;
        }
        if (b.type === "dashboard") {
          return (
            <DashboardBlock
              key={i}
              dashboardId={b.dashboardId}
              title={b.title}
              description={b.description}
              charts={b.charts}
            />
          );
        }
        if (b.type === "insight-proposals") {
          return <InsightProposalsBlock key={i} proposals={b.proposals} />;
        }
        return null;
      })}
    </div>
  );
}

/**
 * Render assistant text as Markdown. The agent emits bold/lists/code
 * spans naturally; before this component the text rendered as raw
 * `* **Total Sales:**` literals which read as broken UI.
 *
 * GFM is enabled for `~~strikethrough~~` and pipe-tables (the latter
 * are discouraged by the system prompt — run_sql results render
 * separately — but if the model emits one we render it cleanly).
 *
 * Class overrides tighten the default markdown spacing for chat
 * density and re-apply our typography tokens so light/dark themes
 * stay consistent.
 */
function AssistantText({ text }: { text: string }) {
  return (
    <div className="text-[14px] leading-relaxed text-text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="text-text-primary">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children }) => (
            <code className="rounded bg-elevated px-1 py-0.5 font-mono text-[12px] text-text-secondary">
              {children}
            </code>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-accent-strong"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h3 className="my-2 text-[16px] font-semibold">{children}</h3>,
          h2: ({ children }) => <h3 className="my-2 text-[16px] font-semibold">{children}</h3>,
          h3: ({ children }) => <h3 className="my-2 text-[15px] font-semibold">{children}</h3>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Mutator that maps one SSE event into setMessages updates. */
function applyEvent(
  assistantId: string,
  event: {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    title?: string;
    spec?: unknown;
    rows?: Record<string, unknown>[];
    chatId?: string;
    dashboardId?: string;
    description?: string;
    charts?: DashboardChart[];
    proposals?: ChatInsightProposal[];
  },
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  setChatId: React.Dispatch<React.SetStateAction<string | undefined>>
): void {
  if (event.type === "message_start" && event.chatId) {
    setChatId(event.chatId);
    return;
  }

  if (event.type === "text_delta" && event.text) {
    const text = event.text;
    setMessages((msgs) =>
      msgs.map((m) => {
        if (m.id !== assistantId) return m;
        const last = m.blocks[m.blocks.length - 1];
        if (last?.type === "text") {
          const updated = [...m.blocks];
          updated[updated.length - 1] = { type: "text", text: last.text + text };
          return { ...m, blocks: updated };
        }
        return { ...m, blocks: [...m.blocks, { type: "text", text }] };
      })
    );
    return;
  }

  if (event.type === "tool_use" && event.id && event.name) {
    const id = event.id;
    const name = event.name;
    const input = event.input;
    setMessages((msgs) =>
      msgs.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              blocks: [...m.blocks, { type: "tool", id, name, status: "running", input }],
            }
          : m
      )
    );
    return;
  }

  if (event.type === "tool_result" && event.id) {
    const id = event.id;
    const output = event.output;
    const error = event.error;
    setMessages((msgs) =>
      msgs.map((m) => {
        if (m.id !== assistantId) return m;
        const updated = m.blocks.map((b) =>
          b.type === "tool" && b.id === id
            ? { ...b, status: error ? ("error" as const) : ("done" as const), output, error }
            : b
        );
        return { ...m, blocks: updated };
      })
    );
    return;
  }

  if (event.type === "error" && event.error) {
    const text = `\n\n_Error: ${event.error}_`;
    setMessages((msgs) =>
      msgs.map((m) => {
        if (m.id !== assistantId) return m;
        const last = m.blocks[m.blocks.length - 1];
        if (last?.type === "text") {
          const updated = [...m.blocks];
          updated[updated.length - 1] = { type: "text", text: last.text + text };
          return { ...m, blocks: updated };
        }
        return { ...m, blocks: [...m.blocks, { type: "text", text }] };
      })
    );
    return;
  }

  if (event.type === "chart" && event.id && event.title && event.spec) {
    const id = event.id;
    const title = event.title;
    const spec = event.spec;
    setMessages((msgs) =>
      msgs.map((m) =>
        m.id === assistantId
          ? { ...m, blocks: [...m.blocks, { type: "chart", id, title, spec }] }
          : m
      )
    );
    return;
  }

  // Table from run_sql — without this case the rows are streamed and
  // then dropped on the floor (the bug screenshot the user reported).
  if (event.type === "table" && event.id && Array.isArray(event.rows)) {
    const id = event.id;
    const rows = event.rows;
    setMessages((msgs) =>
      msgs.map((m) =>
        m.id === assistantId
          ? { ...m, blocks: [...m.blocks, { type: "table", id, rows }] }
          : m
      )
    );
    return;
  }

  // Dashboard from make_dashboard — renders a mini-grid of the
  // composed charts inline. Previously the agent yielded a `chart`
  // event with an empty spec and the chat showed a blank card.
  if (
    event.type === "dashboard" &&
    event.id &&
    event.dashboardId &&
    event.title &&
    Array.isArray(event.charts)
  ) {
    const id = event.id;
    const dashboardId = event.dashboardId;
    const title = event.title;
    const description = event.description;
    const charts = event.charts;
    setMessages((msgs) =>
      msgs.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              blocks: [
                ...m.blocks,
                { type: "dashboard", id, dashboardId, title, description, charts },
              ],
            }
          : m
      )
    );
    return;
  }

  // Proposed insights from propose_insights. The cards are inline in
  // chat; user clicks Save per proposal to persist. Nothing is in
  // Firestore at this point.
  if (
    event.type === "insight-proposals" &&
    event.id &&
    Array.isArray(event.proposals)
  ) {
    const id = event.id;
    const proposals = event.proposals as ChatInsightProposal[];
    setMessages((msgs) =>
      msgs.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              blocks: [
                ...m.blocks,
                { type: "insight-proposals", id, proposals },
              ],
            }
          : m
      )
    );
    return;
  }
}


interface PersistedMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  toolBlocks?: PersistedToolBlock[];
}

type PersistedToolBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown };

/**
 * Rebuild the in-memory MessageBlock tree from Firestore-persisted
 * messages. agent.ts stringifies tool_use.input and tool_result.content
 * before write (Firestore-safety against nested arrays); we parse them
 * back here.
 *
 * For each tool_use → tool_result pair we look at the input and
 * reconstruct the chart / table / dashboard blocks that were yielded
 * over SSE at the time. The persisted data has everything needed:
 *   - run_sql        → table block (rows from tool_result.content)
 *   - make_chart     → chart block (spec from tool_use.input.echartsOption)
 *   - make_dashboard → dashboard block (charts from tool_use.input.charts)
 *   - list_tables    → tool block only (no client-side render)
 */
function reconstructMessages(persisted: PersistedMessage[]): Message[] {
  return persisted.map((m): Message => {
    if (m.role === 'user') {
      return {
        id: m.id,
        role: 'user',
        blocks: [{ type: 'text', text: m.content ?? '' }],
      };
    }
    const blocks: MessageBlock[] = [];
    const toolUseInput = new Map<string, { name: string; input: unknown }>();
    for (const b of m.toolBlocks ?? []) {
      if (b.type === 'text') {
        blocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use') {
        const input = unwrapJsonField(b.input);
        toolUseInput.set(b.id, { name: b.name, input });
        blocks.push({
          type: 'tool',
          id: b.id,
          name: b.name,
          status: 'done',
          input,
        });
      } else if (b.type === 'tool_result') {
        const content = unwrapJsonField(b.content);
        // Mutate the matching tool block (the one we just pushed) so
        // its output renders; also push a chart / table / dashboard
        // companion block if the tool's recorded input supports it.
        const tool = blocks.find(
          (x) => x.type === 'tool' && x.id === b.tool_use_id
        );
        if (tool && tool.type === 'tool') {
          tool.output = content;
        }
        const meta = toolUseInput.get(b.tool_use_id);
        if (!meta) continue;
        const companion = reconstructCompanion(b.tool_use_id, meta, content);
        if (companion) blocks.push(companion);
      }
    }
    return { id: m.id, role: 'assistant', blocks };
  });
}

function reconstructCompanion(
  toolUseId: string,
  meta: { name: string; input: unknown },
  content: unknown
): MessageBlock | null {
  if (meta.name === 'run_sql') {
    const rows = (content as { rows?: Record<string, unknown>[] })?.rows;
    if (Array.isArray(rows)) {
      return { type: 'table', id: toolUseId, rows };
    }
  }
  if (meta.name === 'make_chart') {
    const i = meta.input as { title?: string; echartsOption?: unknown } | null;
    if (i?.title && i?.echartsOption) {
      return {
        type: 'chart',
        id: toolUseId,
        title: i.title,
        spec: i.echartsOption,
      };
    }
  }
  if (meta.name === 'make_dashboard' || meta.name === 'update_dashboard') {
    const i = meta.input as
      | {
          title?: string;
          description?: string;
          charts?: Array<{
            title?: string;
            echartsOption?: unknown;
            colSpan?: 'small' | 'medium' | 'large';
          }>;
        }
      | null;
    const dashboardId =
      (content as { dashboardId?: string })?.dashboardId ??
      (meta.input as { dashboardId?: string })?.dashboardId;
    if (i?.title && Array.isArray(i.charts) && dashboardId) {
      return {
        type: 'dashboard',
        id: toolUseId,
        dashboardId,
        title: i.title,
        description: i.description,
        charts: i.charts.map((c, order) => ({
          order,
          title: c.title ?? '',
          spec: c.echartsOption,
          ...(c.colSpan ? { colSpan: c.colSpan } : {}),
        })),
      };
    }
  }
  if (meta.name === 'propose_insights') {
    // Proposal cards survive a chat reload — the tool's persisted
    // input still has the full list. Save state is page-load-scoped
    // in the block component, so the Save button shows as fresh
    // again after reload. If the user already saved a proposal, the
    // duplicate-save risk is acknowledged in the block component's
    // header comment.
    const i = meta.input as { proposals?: ChatInsightProposal[] } | null;
    if (Array.isArray(i?.proposals) && i.proposals.length > 0) {
      return {
        type: 'insight-proposals',
        id: toolUseId,
        proposals: i.proposals,
      };
    }
  }
  return null;
}

function unwrapJsonField(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}


/**
 * Sticky-style banner at the top of the chat surface when the user
 * arrived via Edit on a chart or dashboard. Makes the editing
 * context visible at all times during the session, with a close
 * affordance to exit edit mode (clears sessionStorage + state).
 */
function EditBanner({
  ctx,
  onStop,
}: {
  ctx: EditContext;
  onStop: () => void;
}) {
  const kindLabel = ctx.kind === "chart" ? "chart" : "dashboard";
  return (
    <div className="flex items-center gap-3 border-b border-border bg-accent-muted/40 px-6 py-2.5">
      <PencilIcon className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1 text-[13px] text-text-primary">
        <span className="text-text-tertiary">Editing {kindLabel}</span>{" "}
        <span className="font-medium">{ctx.title}</span>
      </div>
      <button
        type="button"
        onClick={onStop}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        aria-label="Exit edit mode"
      >
        <CloseIcon />
        <span>Exit</span>
      </button>
    </div>
  );
}
