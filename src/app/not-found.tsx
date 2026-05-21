import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, EcgLogo } from "@/components/icons";

/**
 * Global 404 page. Next.js auto-routes any unmatched URL to this
 * file, rendered inside the root layout (so the html, font, theme
 * script, and ClerkProvider all wrap it) but OUTSIDE the nested
 * (marketing) / (app) / (auth) layouts.
 *
 * Design intent — play the brand's heartbeat metaphor straight:
 * the ECG line on this page is FLAT, not pulsing. "Couldn't find a
 * heartbeat at this address." reads as a 404 message and reinforces
 * the brand mark at the same time.
 *
 * Robots noindex via metadata so 404 URLs don't pollute search
 * results when a crawler hits a deleted page.
 */

export const metadata: Metadata = {
  title: "Page not found",
  description: "We couldn't find what you were looking for.",
  robots: {
    index: false,
    follow: false,
  },
};

const ECG_FLATLINE_PATH =
  "M0 100 L2400 100";

export default function NotFound() {
  return (
    <div className="bg-radial-glow relative flex min-h-screen flex-col">
      {/* Minimal full-bleed nav — just the logo + "Back to home" link.
          No marketing nav links here on purpose; the user has clearly
          hit something broken and we don't want to scatter their
          attention. */}
      <nav className="flex items-center px-6 py-5 lg:px-10">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-text-primary"
          aria-label="Liveli home"
        >
          <EcgLogo className="text-accent" size={28} />
          <span className="text-[18px] font-semibold tracking-tight font-heading">
            Liveli
          </span>
        </Link>
      </nav>

      {/* Centred main content */}
      <main className="container-page relative flex flex-1 flex-col items-center justify-center text-center">
        {/* Flatline ECG — same path mechanic as the hero's pulsing
            heartbeat, but the path is literally a straight horizontal
            line at y=100. Reinforces the "no heartbeat at this
            address" copy below. */}
        <svg
          className="hero-ecg pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[200px] w-screen -translate-x-1/2 -translate-y-1/2"
          viewBox="0 0 2400 200"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="ecg-edge-fade-404" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="white" stopOpacity="0" />
              <stop offset="0.12" stopColor="white" stopOpacity="1" />
              <stop offset="0.88" stopColor="white" stopOpacity="1" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <mask id="ecg-edge-mask-404">
              <rect width="100%" height="100%" fill="url(#ecg-edge-fade-404)" />
            </mask>
          </defs>
          <g mask="url(#ecg-edge-mask-404)">
            <path
              d={ECG_FLATLINE_PATH}
              stroke="var(--accent)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity="0.35"
              fill="none"
            />
          </g>
        </svg>

        <span className="mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-accent-subtle px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
          Error 404
        </span>

        <h1 className="text-[120px] font-semibold leading-none tracking-[-0.04em] text-text-primary sm:text-[180px] lg:text-[220px] font-heading">
          <span className="bg-gradient-to-br from-accent via-accent to-accent-hover bg-clip-text text-transparent">
            404
          </span>
        </h1>

        <p className="mt-8 max-w-[520px] text-[17px] leading-[1.6] text-text-secondary sm:text-[19px]">
          Couldn&rsquo;t find a heartbeat at this address. The page you&rsquo;re
          looking for doesn&rsquo;t exist, or it&rsquo;s been moved.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_28px_var(--accent-glow-strong)] hover:scale-[1.02] active:scale-[0.98]"
          >
            Back to home
            <ArrowRightIcon />
          </Link>
          <Link
            href="/#pricing"
            className="inline-flex items-center gap-2 rounded-full border border-border px-6 py-3 text-[15px] font-medium text-text-primary transition-colors hover:border-border-hover hover:bg-hover"
          >
            See pricing
          </Link>
        </div>
      </main>

      {/* Compact footer — single attribution line, no sitemap.
          Keeps the page focused on the recovery path. */}
      <footer className="border-t border-border-subtle px-6 py-6 text-center text-[12px] text-text-tertiary lg:px-10">
        © {new Date().getFullYear()} Liveli Ltd · Built in the UK
      </footer>
    </div>
  );
}
