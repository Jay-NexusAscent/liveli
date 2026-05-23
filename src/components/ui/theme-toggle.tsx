"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "liveli-theme";
type Theme = "dark" | "light";

/**
 * useSyncExternalStore plumbing for the user's stored theme preference.
 *
 * Why useSyncExternalStore (not useState + useEffect): the latter reads
 * localStorage in an effect and calls setState in the effect body,
 * which trips `react-hooks/set-state-in-effect`. More importantly,
 * useSyncExternalStore handles the SSR ↔ CSR transition natively:
 * `getServerSnapshot` returns the SSR value, so hydration markup
 * matches the server, then React immediately re-renders with
 * `getSnapshot` for the real client value. No hydration mismatch,
 * no setState-in-effect, and we additionally pick up cross-tab
 * theme changes for free (the `storage` event fires in other tabs
 * when our `localStorage.setItem` runs here).
 */
function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getSnapshot(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  return stored ?? "dark";
}

function getServerSnapshot(): Theme {
  // Server has no localStorage and our default theme is dark — match
  // the dark-mode markup on first paint so hydration is clean.
  return "dark";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isDark = theme === "dark";

  const toggle = () => {
    const next: Theme = isDark ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.setAttribute("data-theme", next);
    // The `storage` event only fires for OTHER tabs, not the
    // originating one. Dispatch a synthetic StorageEvent so this
    // tab's useSyncExternalStore subscribers re-snapshot too.
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={!isDark}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Switch to ${isDark ? "light" : "dark"} theme`}
      className="group relative flex h-9 w-9 items-center justify-center rounded-full border border-transparent text-text-secondary transition-all hover:border-border hover:bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {/* Sun — visible in dark mode (means "switch TO light") */}
      <svg
        className={`absolute h-[18px] w-[18px] transition-all duration-300 ${
          isDark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0"
        }`}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="10" cy="10" r="3.5" />
        <path d="M10 1.5v2M10 16.5v2M3.5 10h-2M18.5 10h-2M5.2 5.2L3.8 3.8M16.2 16.2l-1.4-1.4M5.2 14.8L3.8 16.2M16.2 3.8l-1.4 1.4" />
      </svg>
      {/* Moon — visible in light mode (means "switch TO dark") */}
      <svg
        className={`absolute h-[18px] w-[18px] transition-all duration-300 ${
          isDark ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"
        }`}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M16 11.5A6.5 6.5 0 018.5 4 6.5 6.5 0 1016 11.5z" />
      </svg>
    </button>
  );
}
