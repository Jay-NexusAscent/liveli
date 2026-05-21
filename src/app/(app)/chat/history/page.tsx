"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  HistoryIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/icons";

interface ChatListItem {
  id: string;
  title: string;
  createdAt?: { _seconds?: number } | null;
}

/**
 * /chat/history — the customer's index of past conversations.
 *
 * Each row links to /chat/[chatId] (resume), or offers in-place
 * rename and delete. The chat-window UI on /chat/[chatId] loads
 * messages via /api/chats/[chatId]/messages and reconstructs the
 * past blocks (text + tool calls + charts + tables + dashboards
 * are all replayable from persisted toolBlocks).
 *
 * Sort: most-recent first (the GET endpoint already orders by
 * createdAt desc). Capped at 200; pagination is a follow-up if
 * needed.
 */
export default function ChatHistoryPage() {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Mount-only fetch. The setState calls all happen AFTER `await`
  // (inside async callbacks), which the react-hooks/set-state-in-effect
  // rule explicitly allows — what it forbids is setState in the
  // synchronous body of the effect. A `cancelled` flag guards against
  // setState-after-unmount in StrictMode's dev double-mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chats");
        if (cancelled) return;
        if (res.ok) {
          const json = await res.json();
          if (cancelled) return;
          setChats(json.items ?? []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function deleteChat(id: string, title: string) {
    if (!confirm(`Delete "${title}"? All messages will be removed. This can't be undone.`)) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChats((cs) => cs.filter((c) => c.id !== id));
    } catch (err) {
      alert(`Failed to delete chat: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function saveRename(id: string) {
    const next = renameDraft.trim();
    if (!next) {
      setRenamingId(null);
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(`/api/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChats((cs) => cs.map((c) => (c.id === id ? { ...c, title: next } : c)));
      setRenamingId(null);
    } catch (err) {
      alert(`Failed to rename: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="container-page py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">
            Chat history
          </h1>
          <p className="mt-1 text-[14px] text-text-secondary">
            Your past conversations with the agent. Click one to continue where you left off.
          </p>
        </div>
        <Link
          href="/chat"
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-text-inverted transition-opacity hover:opacity-90"
        >
          <PlusIcon />
          New chat
        </Link>
      </header>

      {loading && <p className="text-[13px] text-text-tertiary">Loading…</p>}

      {!loading && chats.length === 0 && (
        <div className="card-elevated flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-muted text-accent">
            <HistoryIcon className="text-accent" />
          </div>
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary font-heading">
            No past chats yet
          </h2>
          <p className="max-w-md text-[14px] text-text-secondary">
            Open the Chat tab and ask the agent a question. Your conversations will appear here so
            you can continue them later.
          </p>
          <Link
            href="/chat"
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-text-inverted"
          >
            <PlusIcon />
            Start a chat
          </Link>
        </div>
      )}

      {!loading && chats.length > 0 && (
        <ul className="card-elevated divide-y divide-border">
          {chats.map((c) => {
            const isRenaming = renamingId === c.id;
            const isBusy = busyId === c.id;
            return (
              <li key={c.id} className="group flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    <input
                      type="text"
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(c.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => void saveRename(c.id)}
                      className="w-full rounded border border-border bg-background px-2 py-1 text-[14px] text-text-primary focus:border-accent focus:outline-none"
                    />
                  ) : (
                    <Link
                      href={`/chat/${c.id}`}
                      className="block truncate text-[14px] text-text-primary hover:text-accent"
                    >
                      {c.title}
                    </Link>
                  )}
                  <div className="mt-0.5 text-[11px] text-text-tertiary">
                    {formatRelative(c.createdAt)}
                  </div>
                </div>
                {!isRenaming && (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <IconButton
                      onClick={() => {
                        setRenameDraft(c.title);
                        setRenamingId(c.id);
                      }}
                      disabled={isBusy}
                      ariaLabel={`Rename ${c.title}`}
                      variant="neutral"
                    >
                      <PencilIcon />
                    </IconButton>
                    <IconButton
                      onClick={() => deleteChat(c.id, c.title)}
                      disabled={isBusy}
                      ariaLabel={`Delete ${c.title}`}
                      variant="danger"
                    >
                      <TrashIcon />
                    </IconButton>
                    <Link
                      href={`/chat/${c.id}`}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
                      aria-label={`Open ${c.title}`}
                    >
                      Open
                      <ArrowRightIcon className="h-3 w-3" />
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function IconButton({
  onClick,
  disabled,
  ariaLabel,
  variant,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  variant: "neutral" | "danger";
  children: React.ReactNode;
}) {
  const base =
    "shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const hover =
    variant === "danger"
      ? "hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)]"
      : "hover:bg-hover hover:text-text-primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`${base} ${hover}`}
    >
      {children}
    </button>
  );
}

function formatRelative(createdAt?: { _seconds?: number } | null): string {
  if (!createdAt?._seconds) return "";
  const ms = createdAt._seconds * 1000;
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
