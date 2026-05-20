"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Reveals its children with a subtle fade + lift-up animation when the
 * element enters the viewport. Single-shot: once revealed, the
 * IntersectionObserver disconnects so scrolling back up doesn't replay
 * the animation (re-triggering reveals on every direction change reads
 * as a buggy slideshow).
 *
 * Honours prefers-reduced-motion in lockstep with the rest of the
 * site's motion policy (see globals.css `.ecg-pulse` and
 * `CyclingHeadline`) — motion-sensitive users see content rendered
 * immediately, fully visible, no animation.
 *
 * Usage:
 *   <ScrollReveal>...</ScrollReveal>
 *   <ScrollReveal delay={100}>...</ScrollReveal>  // staggered cascade
 */

interface ScrollRevealProps {
  children: ReactNode;
  /** Milliseconds to delay the reveal. Use to stagger sibling cards. */
  delay?: number;
  /** Optional extra classes applied to the wrapper. */
  className?: string;
}

export function ScrollReveal({
  children,
  delay = 0,
  className = "",
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Bypass animation entirely for users with the OS reduced-motion
    // preference. Render content in its final state immediately.
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setVisible(true);
      return;
    }

    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          // Single-shot: don't replay the reveal if the user scrolls
          // back up past the element later.
          observer.disconnect();
        }
      },
      {
        // Reveal triggers once 15% of the element is on screen — early
        // enough that motion finishes before the eye lands on the
        // element, not so early that off-screen content animates.
        threshold: 0.15,
        // Pull the trigger up 50px so the reveal feels timed to the
        // element entering the comfortable reading zone, not the
        // viewport edge.
        rootMargin: "0px 0px -50px 0px",
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-700 ease-out ${
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-6 opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  );
}
