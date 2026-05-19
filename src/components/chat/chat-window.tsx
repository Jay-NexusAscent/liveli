"use client";

import { useEffect, useRef, useState } from "react";
import { SparkleIcon } from "@/components/icons";
import { ChartBlock } from "./chart-block";
import { ToolCallBlock } from "./tool-call-block";

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
  | { type: "chart"; id: string; title: string; spec: unknown };

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

export function ChatWindow() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Prefill from sessionStorage — used by the /insights "Query further"
  // CTAs to drop the user into chat with a starter question ready.
  // sessionStorage (not a URL param) is the right channel here for two
  // reasons:
  //   1) URL stays clean — no stale prefill text in the address bar.
  //   2) Survives React Strict Mode's double-mount in dev. URL-based
  //      one-shot consumption is destructive: the second mount sees the
  //      already-stripped URL and can't repopulate state. sessionStorage
  //      remains readable until we explicitly clear it on send.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefill = sessionStorage.getItem("liveli.chatPrefill");
    if (prefill) setInput(prefill);
  }, []);

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
        body: JSON.stringify({ message: text, chatId }),
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
      {/* Scrollable message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {messages.length === 0 ? (
            <EmptyState onPick={sendMessage} />
          ) : (
            <div className="space-y-6">
              {messages.map((m) => (
                <MessageItem key={m.id} message={m} chatId={chatId} />
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

function MessageItem({ message, chatId }: { message: Message; chatId?: string }) {
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
          return (
            <div
              key={i}
              className="whitespace-pre-wrap text-[14px] leading-relaxed text-text-primary"
            >
              {b.text}
            </div>
          );
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
        return null;
      })}
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
    chatId?: string;
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
}
