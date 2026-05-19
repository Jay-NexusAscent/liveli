"use client";

import { useEffect, useState } from "react";

/**
 * Rotating hero headlines. Each entry is a (lead, accent) tuple where:
 *  - `lead`   renders on line 1 in the primary text colour
 *  - `accent` renders on line 2 with the indigo gradient
 *
 * Constraint: every line MUST fit within the H1's max-width at the
 * largest breakpoint. A headline that wraps to 3 lines while others
 * are 2 lines causes a vertical layout shift below the H1 every
 * rotation — bad UX. The fixed `min-height` on the wrapper is a
 * second line of defence, but the right answer is short copy.
 *
 * No timing claims here ("8 seconds" etc.) — those belong on the
 * stat card below with its `MEDIAN` qualifier intact, not in a hero
 * headline that gets screenshotted and quoted without context.
 */
const HEADLINES = [
  { lead: "Talk to your", accent: "data." },
  { lead: "Fully managed agentic", accent: "data platform." },
  { lead: "Plain English in.", accent: "Charts out." },
  { lead: "No SQL.", accent: "Just answers." },
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
    // Fixed min-height per breakpoint = 2 lines at that breakpoint's
    // font size with leading-[1.05]. This freezes the vertical space
    // the H1 occupies so the sub, CTAs, ECG band, and stat strip
    // below it never jump during a rotation.
    //   - 44px font × 1.05 × 2 lines ≈ 92px  (mobile)
    //   - 56px font × 1.05 × 2 lines ≈ 118px (sm)
    //   - 68px font × 1.05 × 2 lines ≈ 143px (lg)
    <h1 className="min-h-[100px] text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary sm:min-h-[124px] sm:text-[56px] lg:min-h-[150px] lg:text-[68px] font-heading">
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
