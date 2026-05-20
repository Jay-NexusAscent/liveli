"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { CloseIcon } from "@/components/icons";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

type FullscreenContent =
  | { kind: "chart"; title: string; spec: unknown }
  | {
      kind: "dashboard";
      title: string;
      description?: string | null;
      charts: Array<{ order: number; title: string; spec: unknown }>;
    };

interface FullscreenModalProps {
  content: FullscreenContent | null;
  onClose: () => void;
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
export function FullscreenModal({ content, onClose }: FullscreenModalProps) {
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

  const isLightTheme = document.documentElement.getAttribute("data-theme") === "light";

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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-6">
          {content.kind === "chart" ? (
            <ReactECharts
              option={content.spec as object}
              style={{ height: "calc(100vh - 200px)", width: "100%" }}
              theme={isLightTheme ? "default" : "dark"}
              opts={{ renderer: "svg" }}
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {[...content.charts]
                .sort((a, b) => a.order - b.order)
                .map((c, i) => (
                  <div key={i} className="rounded-md border border-border bg-background/40 p-4">
                    <div className="mb-2 text-[13px] font-medium text-text-primary">
                      {c.title}
                    </div>
                    <ReactECharts
                      option={c.spec as object}
                      style={{ height: 360, width: "100%" }}
                      theme={isLightTheme ? "default" : "dark"}
                      opts={{ renderer: "svg" }}
                    />
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
