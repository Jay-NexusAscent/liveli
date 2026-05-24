"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toPng } from "html-to-image";
import { CheckIcon, CloseIcon, CopyIcon, PencilIcon } from "@/components/icons";
import { ChartRenderer } from "@/components/chat/chart-renderer";

type ColSpan = "extra-small" | "small" | "medium" | "large";

// Mirror of the page's COL_SPAN_CLASSES — written out as full
// literal strings for Tailwind JIT detection. `lg:` here because
// the fullscreen grid hits the lg breakpoint (not md), matching
// the existing `lg:grid-cols-4` below.
//
// Fullscreen modal doesn't use row-span — it lets each tile take
// its natural content height because the modal is already taking
// the full viewport. Row-span is only useful in the in-page
// dashboards grid where we want to claim vertical real estate
// back.
const COL_SPAN_CLASSES: Record<ColSpan, string> = {
  "extra-small": "lg:col-span-1",
  small: "lg:col-span-1",
  medium: "lg:col-span-2",
  large: "lg:col-span-4",
};

type FullscreenContent =
  | { kind: "chart"; id: string; title: string; spec: unknown }
  | {
      kind: "dashboard";
      id: string;
      title: string;
      description?: string | null;
      charts: Array<{ order: number; title: string; spec: unknown; colSpan?: ColSpan }>;
    };

interface FullscreenModalProps {
  content: FullscreenContent | null;
  onClose: () => void;
  /**
   * Optional callback to open the current content in chat-edit mode.
   * When provided, an Edit button renders alongside Copy in the
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
 * Copy: snapshots the modal panel as a PNG and writes it to the
 * clipboard as an image. Users paste straight into Outlook, Teams,
 * Slack, etc. — flat image, no auth-walled link to dead-end on. The
 * action buttons themselves are excluded from the capture via a
 * data-attribute filter so the screenshot shows just the title +
 * chart(s).
 *
 * Portaled to document.body so the modal isn't constrained by parent
 * layouts (sidebar, padding, overflow).
 */
export function FullscreenModal({ content, onClose, onEdit }: FullscreenModalProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  // Track the last content.id we saw so we can reset copyState when
  // the user navigates to a different chart/dashboard without the
  // modal closing in between (e.g. flipping between tiles via Edit →
  // open in fullscreen again).
  //
  // React docs recommend this "adjust state during render" pattern
  // over the previous setState-in-effect approach
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  // Setting state during render is collapsed into the same render
  // pass — no cascading re-render, and no react-hooks/set-state-in-effect
  // violation.
  const currentContentId = content?.id ?? null;
  const [seenContentId, setSeenContentId] = useState<string | null>(currentContentId);
  if (currentContentId !== seenContentId) {
    setSeenContentId(currentContentId);
    setCopyState("idle");
  }
  // Ref onto the modal panel itself — html-to-image walks this subtree
  // to produce the PNG. Buttons inside are tagged data-capture-exclude
  // so they don't appear in the screenshot.
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Bind Esc + lock body scroll while open. Cleanup removes both.
  useEffect(() => {
    if (!content) return;
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

  const handleCopy = async () => {
    if (!panelRef.current) return;
    // Feature-detect ClipboardItem up front. Older Firefox / Safari
    // versions support clipboard.writeText but not write-with-blob.
    // Fail fast with a useful error state rather than letting the
    // browser throw an opaque DOMException mid-render.
    if (typeof window.ClipboardItem === "undefined") {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2000);
      return;
    }
    try {
      // pixelRatio: 2 for retina-sharp output when pasted into Teams /
      // Outlook (which often display at native DPI).
      const dataUrl = await toPng(panelRef.current, {
        pixelRatio: 2,
        // Filter the action-buttons cluster out of the capture — we
        // don't want the Copy / Edit / Close buttons in the PNG.
        filter: (node) => {
          if (!(node instanceof HTMLElement)) return true;
          return node.dataset.captureExclude !== "true";
        },
        // Match the modal's background so anti-aliased edges blend.
        // Reading the actual computed color of the panel keeps light /
        // dark themes correct without hard-coding hex values.
        backgroundColor:
          getComputedStyle(panelRef.current).backgroundColor || undefined,
      });
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2000);
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
        ref={panelRef}
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
          <div
            data-capture-exclude="true"
            className="flex shrink-0 items-center gap-1"
          >
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
              onClick={handleCopy}
              aria-label={
                copyState === "copied"
                  ? "Copied to clipboard"
                  : copyState === "error"
                    ? "Copy failed — your browser may not support image clipboard"
                    : "Copy as image"
              }
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                copyState === "copied"
                  ? "bg-[color:var(--status-success)]/12 text-[color:var(--status-success)]"
                  : copyState === "error"
                    ? "bg-[color:var(--status-error)]/12 text-[color:var(--status-error)]"
                    : "text-text-secondary hover:bg-hover hover:text-text-primary"
              }`}
            >
              {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
              <span>
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "error"
                    ? "Copy failed"
                    : "Copy"}
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
            <div className="grid gap-4 lg:grid-cols-4">
              {[...content.charts]
                .sort((a, b) => a.order - b.order)
                .map((c, i) => (
                  <div
                    key={i}
                    className={`rounded-md border border-border bg-background/40 p-4 ${
                      COL_SPAN_CLASSES[c.colSpan ?? "medium"]
                    }`}
                  >
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
