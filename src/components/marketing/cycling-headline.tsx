"use client";

import { useEffect, useState } from "react";

/**
 * Rotating hero headlines. Each entry is a (lead, accent) tuple where:
 *  - `lead`   renders on line 1 in the primary text colour
 *  - `accent` renders on line 2 with the indigo gradient
 *
 * Keep all accent strings short enough to fit one line at lg:80px so
 * the H1 stays exactly two lines tall — that's what stops the layout
 * jumping during the crossfade.
 *
 * Order is intentional: visitor-action → product-positioning → mechanism
 * → speed → contrarian-replacement. Each angle is distinct so the
 * rotation builds a picture rather than restating the same idea five
 * times.
 */
const HEADLINES = [
  { lead: "Talk to your", accent: "data." },
  { lead: "Fully managed agentic", accent: "data platform." },
  { lead: "Plain English in.", accent: "Charts out." },
  { lead: "Question to chart in", accent: "8 seconds." },
  { lead: "No SQL, no dashboards,", accent: "just answers." },
];

const INTERVAL_MS = 4500;
const FADE_MS = 500;

export function CyclingHeadline() {
  const [idx, setIdx] = useState(0);
  const [show, setShow] = useState(true);

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
      setShow(false);
      const swap = setTimeout(() => {
        setIdx((i) => (i + 1) % HEADLINES.length);
        setShow(true);
      }, FADE_MS);
      return () => clearTimeout(swap);
    }, INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const { lead, accent } = HEADLINES[idx];

  return (
    <h1 className="text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary sm:text-[64px] lg:text-[80px] font-heading">
      <span
        className={`block transition-all duration-500 ease-out ${
          show
            ? "opacity-100 translate-y-0"
            : "-translate-y-2 opacity-0"
        }`}
      >
        {lead}
        <br />
        <span className="bg-gradient-to-br from-accent via-accent to-accent-hover bg-clip-text text-transparent">
          {accent}
        </span>
      </span>
    </h1>
  );
}
