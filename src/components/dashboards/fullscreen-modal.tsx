"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toPng } from "html-to-image";
import { CheckIcon, CloseIcon, CopyIcon, PencilIcon } from "@/components/icons";
import { ChartRenderer } from "@/components/chat/chart-renderer";
import type { WorkspaceSettings } from "@/lib/workspace-settings";

import type { ColSpan } from "@/lib/dashboards/types";

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

/** True when a spec's first series is a KPI tile (no axes, one number). */
function isKpiSpec(spec: unknown): boolean {
  const series = (spec as { series?: Array<{ type?: string }> } | null)?.series;
  return series?.[0]?.type === "kpi";
}

/**
 * Per-tile render height inside the fullscreen grid. KPI tiles are a
 * single headline number — at 360px they sit in a sea of empty space,
 * the exact complaint we're fixing. They get a compact height that
 * matches their visual weight; real charts keep a generous canvas,
 * with `large` (full-width hero) charts taller still.
 */
function chartTileHeight(isKpi: boolean, colSpan?: ColSpan): number {
  if (isKpi) return 150;
  if (colSpan === "large") return 440;
  return 360;
}

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
  /**
   * Workspace regional preferences — passed through to ChartRenderer
   * so currency / locale / timezone match the rest of the app inside
   * the fullscreen overlay too.
   */
  settings?: WorkspaceSettings;
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
export function FullscreenModal({ content, onClose, onEdit, settings }: FullscreenModalProps) {
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
  // Ref onto the scrolling body. Copy temporarily un-scrolls it so the
  // full chart content is captured rather than only the visible slice.
  const bodyRef = useRef<HTMLDivElement | null>(null);

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
    const panel = panelRef.current;
    const body = bodyRef.current;
    // The panel is normally height-constrained to the viewport (it's an
    // `items-stretch` flex child with `m-4`) and its body scrolls. That
    // means html-to-image, which captures an element's rendered box,
    // only sees the visible slice — anything scrolled out of view gets
    // cropped. Before capturing we drop those constraints so the panel
    // grows to its full natural content height; we restore them in the
    // `finally` so the on-screen layout is untouched.
    const prevPanel = {
      alignSelf: panel.style.alignSelf,
      maxHeight: panel.style.maxHeight,
      height: panel.style.height,
    };
    const prevBody = body
      ? { overflow: body.style.overflow, maxHeight: body.style.maxHeight, height: body.style.height }
      : null;
    panel.style.alignSelf = "flex-start";
    panel.style.maxHeight = "none";
    panel.style.height = "auto";
    if (body) {
      body.style.overflow = "visible";
      body.style.maxHeight = "none";
      body.style.height = "auto";
    }
    try {
      // pixelRatio: 2 for retina-sharp output when pasted into Teams /
      // Outlook (which often display at native DPI).
      const dataUrl = await toPng(panel, {
        pixelRatio: 2,
        // Pin width/height to the now-expanded box so the capture
        // covers the full content even on the first paint.
        width: panel.scrollWidth,
        height: panel.scrollHeight,
        // Filter the action-buttons cluster out of the capture — we
        // don't want the Copy / Edit / Close buttons in the PNG.
        filter: (node) => {
          if (!(node instanceof HTMLElement)) return true;
          return node.dataset.captureExclude !== "true";
        },
        // Match the modal's background so anti-aliased edges blend.
        // Reading the actual computed color of the panel keeps light /
        // dark themes correct without hard-coding hex values.
        backgroundColor: getComputedStyle(panel).backgroundColor || undefined,
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
    } finally {
      panel.style.alignSelf = prevPanel.alignSelf;
      panel.style.maxHeight = prevPanel.maxHeight;
      panel.style.height = prevPanel.height;
      if (body && prevBody) {
        body.style.overflow = prevBody.overflow;
        body.style.maxHeight = prevBody.maxHeight;
        body.style.height = prevBody.height;
      }
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

        <div ref={bodyRef} className="flex-1 overflow-auto p-6">
          {content.kind === "chart" ? (
            <ChartRenderer spec={content.spec} height={window.innerHeight - 200} settings={settings} />
          ) : (
            <div className="grid auto-rows-min items-start gap-4 lg:grid-cols-4">
              {[...content.charts]
                .sort((a, b) => a.order - b.order)
                .map((c, i) => {
                  const kpi = isKpiSpec(c.spec);
                  return (
                    <div
                      key={i}
                      className={`rounded-md border border-border bg-background/40 p-4 ${
                        COL_SPAN_CLASSES[c.colSpan ?? "medium"]
                      }`}
                    >
                      <div className="mb-2 text-[13px] font-medium text-text-primary">
                        {c.title}
                      </div>
                      <ChartRenderer
                        spec={c.spec}
                        height={chartTileHeight(kpi, c.colSpan)}
                        settings={settings}
                      />
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
