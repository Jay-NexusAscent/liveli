"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CloseIcon, PencilIcon, ShareIcon } from "@/components/icons";
import { ChartRenderer } from "@/components/chat/chart-renderer";

type FullscreenContent =
  | { kind: "chart"; id: string; title: string; spec: unknown }
  | {
      kind: "dashboard";
      id: string;
      title: string;
      description?: string | null;
      charts: Array<{ order: number; title: string; spec: unknown }>;
    };

interface FullscreenModalProps {
  content: FullscreenContent | null;
  onClose: () => void;
  /**
   * Optional callback to open the current content in chat-edit mode.
   * When provided, an Edit button renders alongside Share in the
   * header. Invoking it closes the modal first so the navigation away
   * to /chat isn't covered by a still-mounted overlay (Esc + scroll
   * locks would otherwise hang around). The parent decides whether to
   * pass this — inner-dashboard chart tiles, for instance, don't get
   * an Edit affordance because they aren't standalone documents.
   */
  onEdit?: () => void;
}

/**
 * Full-viewport modal for a single chart or a whole dashboard.
 *
 * - Single chart: stretches the ECharts canvas to nearly the full
 *   viewport — useful when the inline card is too small to read.
 * - Dashboard: renders the full grid at larger per-chart heights with
 *   the dashboard title + description as a header.
 *
 * Close via:
 *   - Esc key
 *   - clicking the backdrop
 *   - the X button in the top-right
 *
 * Portaled to document.body so the modal isn't constrained by parent
 * layouts (sidebar, padding, overflow).
 */
export function FullscreenModal({ content, onClose, onEdit }: FullscreenModalProps) {
  const [shareState, setShareState] = useState<"idle" | "copied" | "error">("idle");

  // Bind Esc + lock body scroll while open. Cleanup removes both.
  useEffect(() => {
    if (!content) return;
    setShareState("idle");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [content, onClose]);

  if (!content || typeof window === "undefined") return null;

  const shareUrl = `${window.location.origin}/dashboards#${content.kind}-${content.id}`;

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2000);
    } catch {
      setShareState("error");
      window.setTimeout(() => setShareState("idle"), 2000);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={content.title}
    >
      <div
        // Stop backdrop-close from firing when clicking inside the panel.
        onClick={(e) => e.stopPropagation()}
        className="relative m-4 flex w-full max-w-[1400px] flex-col rounded-xl border border-border bg-surface shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[18px] font-semibold tracking-tight text-text-primary font-heading">
              {content.title}
            </h2>
            {content.kind === "dashboard" && content.description && (
              <p className="mt-0.5 text-[13px] text-text-secondary">{content.description}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onEdit && (
              <button
                type="button"
                onClick={() => {
                  // Close first so the portal unmounts before navigation
                  // — keeps body scroll-lock from outliving the modal if
                  // the destination page renders before our cleanup runs.
                  onClose();
                  onEdit();
                }}
                aria-label="Edit in chat"
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
              >
                <PencilIcon />
                <span>Edit</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleShare}
              aria-label={
                shareState === "copied"
                  ? "Copied to clipboard"
                  : "Copy share link"
              }
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                shareState === "copied"
                  ? "bg-[color:var(--status-success)]/12 text-[color:var(--status-success)]"
                  : shareState === "error"
                    ? "bg-[color:var(--status-error)]/12 text-[color:var(--status-error)]"
                    : "text-text-secondary hover:bg-hover hover:text-text-primary"
              }`}
            >
              {shareState === "copied" ? <CheckIcon /> : <ShareIcon />}
              <span>
                {shareState === "copied"
                  ? "Link copied"
                  : shareState === "error"
                    ? "Copy failed"
                    : "Share"}
              </span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-6">
          {content.kind === "chart" ? (
            <ChartRenderer spec={content.spec} height={window.innerHeight - 200} />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {[...content.charts]
                .sort((a, b) => a.order - b.order)
                .map((c, i) => (
                  <div key={i} className="rounded-md border border-border bg-background/40 p-4">
                    <div className="mb-2 text-[13px] font-medium text-text-primary">
                      {c.title}
                    </div>
                    <ChartRenderer spec={c.spec} height={360} />
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
