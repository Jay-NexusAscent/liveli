"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Rotating hero headlines. Each entry is a (lead, accent) tuple where:
 *  - `lead`   renders on line 1 in the primary text colour
 *  - `accent` renders on line 2 with the indigo gradient
 *
 * Layout-shift defence: all headlines render simultaneously as grid
 * children sharing the same cell (`col-start-1 row-start-1`). The H1
 * sizes itself to whichever child is TALLEST at the active viewport
 * width, so the vertical space below it (sub-paragraph, CTAs, ECG
 * band, stat strip) never jumps when the headline rotates. This
 * self-corrects per breakpoint: at mobile widths "Fully Managed
 * Agentic / Data Platform." wraps to 3 lines while its siblings fit
 * on 2 — the H1 takes 3 lines' height there. At lg+ widths every
 * headline fits on 2 — the H1 takes 2.
 *
 * Previous design used a static `min-height` tuned per breakpoint
 * to a 2-line assumption, which broke silently when "Fully Managed
 * Agentic" was added in 7bc3e81 — that headline wraps to 3 lines on
 * mobile/sm and produced a ~46px vertical pop every 4.5 seconds.
 * The min-height approach is fragile to any future copy change; the
 * grid-stack approach is intrinsically correct regardless of copy.
 *
 * Only the active headline is visible (opacity transitions cross-fade
 * over 500ms); inactive ones get `opacity-0`, `pointer-events-none`,
 * `select-none` so they're not interactive, and `aria-hidden` so
 * screen readers only see the active variant.
 *
 * No timing claims here ("8 seconds" etc.) — those belong on the
 * stat card below with its `MEDIAN` qualifier intact, not in a hero
 * headline that gets screenshotted and quoted without context.
 */
const HEADLINES = [
  { lead: "Talk To Your", accent: "Data." },
  { lead: "Fully Managed Agentic", accent: "Data Platform." },
  { lead: "No Code.", accent: "Just Answers." },
  { lead: "The Future Is", accent: "Agentic." },
  { lead: "The Future Is", accent: "Liveli." },
];

const INTERVAL_MS = 4500;

export function CyclingHeadline() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    // Respect reduced-motion preference — stay on the first headline,
    // skip the rotation entirely. Matches the rest of the site's
    // motion policy (see globals.css `.ecg-pulse` reduced-motion block).
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const interval = setInterval(() => {
      setIdx((i) => (i + 1) % HEADLINES.length);
    }, INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return (
    <h1 className="grid text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary sm:text-[56px] lg:text-[68px] font-heading">
      {HEADLINES.map((h, i) => (
        <span
          key={i}
          aria-hidden={i !== idx}
          className={cn(
            "col-start-1 row-start-1 block transition-opacity duration-500 ease-out",
            i === idx
              ? "opacity-100"
              : "pointer-events-none select-none opacity-0"
          )}
        >
          {h.lead}
          <br />
          <span className="bg-gradient-to-br from-accent via-accent to-accent-hover bg-clip-text text-transparent">
            {h.accent}
          </span>
        </span>
      ))}
    </h1>
  );
}
