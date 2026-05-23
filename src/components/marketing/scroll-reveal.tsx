"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

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

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(callback: () => void): () => void {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot(): boolean {
  // Server has no matchMedia; assume motion is allowed. If the user
  // really has reduced-motion set, the first client render flips
  // `visible` to true immediately, which is the desired outcome.
  return false;
}

export function ScrollReveal({
  children,
  delay = 0,
  className = "",
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Drive `prefersReducedMotion` via useSyncExternalStore rather than
  // useState + useEffect: the latter would require a setState in the
  // effect body to record the matchMedia result, which trips
  // react-hooks/set-state-in-effect. SSR returns `false` (motion ok),
  // post-hydration we get the real value and the visible derivation
  // below shows content immediately if reduced-motion is on.
  const prefersReducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
  const [intersected, setIntersected] = useState(false);

  // Visible when EITHER reduced-motion is set (show everything
  // immediately, skip the animation) OR the IntersectionObserver has
  // fired. Computing this during render rather than syncing into a
  // separate state field keeps the effect below free of setState
  // calls in its body.
  const visible = prefersReducedMotion || intersected;

  useEffect(() => {
    // No observer needed when the user prefers reduced motion — we
    // already render `visible: true` via the derivation above.
    if (prefersReducedMotion) return;
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // setState INSIDE the observer callback (a subscription
          // event handler) — explicitly allowed by the
          // react-hooks/set-state-in-effect rule, which only flags
          // setState in the effect body itself.
          setIntersected(true);
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
  }, [prefersReducedMotion]);

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
