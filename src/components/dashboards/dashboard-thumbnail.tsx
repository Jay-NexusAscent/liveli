"use client";

import { useEffect, useRef, useState } from "react";
import { ChartRenderer } from "@/components/chat/chart-renderer";
import { DashboardIcon } from "@/components/icons";
import type { ColSpan } from "@/lib/dashboards/types";
import type { WorkspaceSettings } from "@/lib/workspace-settings";

/**
 * Faithful, uniformly-scaled miniature of a dashboard for the gallery
 * card — the "Mission Control window preview" technique. We render the
 * REAL 4-column colSpan grid with the REAL ChartRenderer (titles, axes
 * and KPI captions intact) at a fixed logical width, then CSS-scale the
 * whole thing down to the card width. Because it's a single uniform
 * downscale of the true layout — not a re-invented mini-grid — it reads
 * as a recognisable shrunken dashboard rather than a row of unlabelled
 * tiles. SVG rendering keeps it crisp at any scale.
 *
 * Trade-off: renders one ECharts instance per chart per visible card.
 * Fine for the current handful of dashboards; if the gallery grows,
 * gate rendering behind an IntersectionObserver or move to server-side
 * snapshot images.
 */

// Mirrors the live dashboard grid (page.tsx COL_SPAN_CLASSES /
// auto-rows-[180px]) minus the `md:` breakpoint prefix — the thumbnail
// is always at its fixed logical width, so the spans are unconditional.
const SPAN_CLASSES: Record<ColSpan, string> = {
  "extra-small": "col-span-1 row-span-1",
  small: "col-span-1 row-span-2",
  medium: "col-span-2 row-span-2",
  large: "col-span-4 row-span-2",
};

const DEFAULT_SPAN: ColSpan = "medium";

// Logical render space (px) — the dashboard is drawn at this width then
// scaled to fit. Matches the real grid's row height + gap so proportions
// are identical to the open dashboard.
const LOGICAL_WIDTH = 1000;
const ROW_H = 180;
const GAP = 16;
const TILE_PAD = 16; // p-2 top+bottom

const rowsFor = (span: ColSpan): number => (span === "extra-small" ? 1 : 2);
const tileHeight = (span: ColSpan): number => {
  const rows = rowsFor(span);
  return rows * ROW_H + (rows - 1) * GAP - TILE_PAD;
};

export function DashboardThumbnail({
  charts,
  settings,
}: {
  charts: Array<{ title: string; spec: unknown; colSpan?: ColSpan }>;
  settings?: WorkspaceSettings;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  // Measure the card's width and derive the scale factor. ResizeObserver
  // keeps it correct across the responsive gallery grid (2-up / 3-up)
  // and window resizes.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / LOGICAL_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (charts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        <DashboardIcon className="text-text-tertiary" />
      </div>
    );
  }

  return (
    // aspect-[16/10] gives a generous, consistent preview area; overflow
    // hidden clips long dashboards to their top (standard thumbnail
    // behaviour) so every card is the same height.
    <div ref={boxRef} className="relative w-full overflow-hidden" style={{ aspectRatio: "16 / 10" }}>
      <div
        // Hidden until measured to avoid a full-size flash on first paint.
        style={{
          width: LOGICAL_WIDTH,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          visibility: scale > 0 ? "visible" : "hidden",
        }}
      >
        <div className="grid grid-cols-4 gap-4" style={{ gridAutoRows: `${ROW_H}px` }}>
          {charts.map((c, i) => {
            const span = c.colSpan ?? DEFAULT_SPAN;
            return (
              <div
                key={i}
                className={`${SPAN_CLASSES[span]} overflow-hidden rounded-lg border border-border bg-surface/60 p-2`}
              >
                <ChartRenderer spec={c.spec} height={tileHeight(span)} settings={settings} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
