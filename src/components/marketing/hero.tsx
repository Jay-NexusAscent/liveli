import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { CyclingHeadline } from "./cycling-headline";

const ECG_PATH =
  "M0 100 L60 100 L80 100 L90 118 L108 42 L126 138 L144 100 L220 100 L240 100 L250 114 L265 50 L280 132 L295 100 L380 100 L400 100 L410 118 L428 42 L446 138 L464 100 L540 100 L560 100 L570 114 L585 50 L600 132 L615 100 L700 100 L720 100 L730 118 L748 42 L766 138 L784 100 L860 100 L880 100 L890 114 L905 50 L920 132 L935 100 L1020 100 L1040 100 L1050 118 L1068 42 L1086 138 L1104 100 L1200 100 L1260 100 L1280 100 L1290 118 L1308 42 L1326 138 L1344 100 L1420 100 L1440 100 L1450 114 L1465 50 L1480 132 L1495 100 L1580 100 L1600 100 L1610 118 L1628 42 L1646 138 L1664 100 L1740 100 L1760 100 L1770 114 L1785 50 L1800 132 L1815 100 L1900 100 L1920 100 L1930 118 L1948 42 L1966 138 L1984 100 L2060 100 L2080 100 L2090 114 L2105 50 L2120 132 L2135 100 L2220 100 L2240 100 L2250 118 L2268 42 L2286 138 L2304 100 L2400 100";

const STATS = [
  { value: "600+", label: "Live connectors", tag: "Live" },
  { value: "< 8s", label: "Question to chart", tag: "Median" },
  { value: "5 min", label: "To first insight", tag: "Setup" },
];

export function MarketingHero() {
  return (
    <section className="relative overflow-hidden pt-24 pb-16 sm:pt-28 sm:pb-20 lg:pt-28 lg:pb-20">
      <div className="container-page relative w-full">
        {/* Centered narrative block — eyebrow, cycling headline, sub,
            CTAs. Single column, centered alignment. The headline cycles
            every 4.5s in a smooth fade + slide-up; respects reduced
            motion preference. */}
        <div className="mx-auto max-w-3xl text-center lg:max-w-4xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-accent-subtle px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
            <span className="live-dot" />
            AI Data Agent — Early Access
          </span>

          <div className="mt-7">
            <CyclingHeadline />
          </div>

          <p className="mx-auto mt-7 max-w-[600px] text-[16px] leading-[1.6] text-text-secondary sm:text-[18px]">
            Liveli connects your data sources, runs the warehouse for you,
            and gives your team an AI analyst that answers questions and
            builds dashboards in plain English. No SQL, no BI tickets, no
            data engineer required.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_28px_var(--accent-glow-strong)] hover:scale-[1.02] active:scale-[0.98]"
            >
              Get started free
              <ArrowRightIcon />
            </Link>
            <Link
              href="/#how-it-works"
              className="inline-flex items-center gap-2 rounded-full border border-border px-6 py-3 text-[15px] font-medium text-text-primary transition-colors hover:border-border-hover hover:bg-hover"
            >
              See how it works
            </Link>
          </div>
        </div>

        {/* ECG divider — brand motif between narrative and proof.
            Compact height so the stat strip below stays in the first
            viewport on standard 1440x900 / 1366x768 laptops. */}
        <div className="relative mt-10 h-[64px] sm:mt-12 sm:h-[80px]">
          <svg
            className="hero-ecg pointer-events-none absolute left-1/2 top-1/2 h-full w-screen -translate-x-1/2 -translate-y-1/2"
            viewBox="0 0 2400 200"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="ecg-edge-fade" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="white" stopOpacity="0" />
                <stop offset="0.08" stopColor="white" stopOpacity="1" />
                <stop offset="0.92" stopColor="white" stopOpacity="1" />
                <stop offset="1" stopColor="white" stopOpacity="0" />
              </linearGradient>
              <mask id="ecg-edge-mask">
                <rect width="100%" height="100%" fill="url(#ecg-edge-fade)" />
              </mask>
            </defs>
            <g mask="url(#ecg-edge-mask)">
              <path className="ecg-base" d={ECG_PATH} />
              <path className="ecg-pulse" d={ECG_PATH} />
            </g>
          </svg>
        </div>

        {/* Trust strip — three glass boxes in a horizontal row.
            Key selling points: surfaced above the fold. */}
        <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-4 sm:mt-10 sm:grid-cols-3">
          {STATS.map((s) => (
            <StatCard key={s.label} value={s.value} label={s.label} tag={s.tag} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StatCard({
  value,
  label,
  tag,
}: {
  value: string;
  label: string;
  tag: string;
}) {
  return (
    <div className="card group flex items-center justify-between gap-4 px-5 py-4 transition-transform duration-300 hover:-translate-y-0.5">
      <div className="flex flex-col gap-1">
        <span className="text-[28px] font-semibold leading-none tracking-tight text-accent tabular-nums font-heading">
          {value}
        </span>
        <span className="text-[13px] text-text-secondary">{label}</span>
      </div>
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
        {tag}
      </span>
    </div>
  );
}
