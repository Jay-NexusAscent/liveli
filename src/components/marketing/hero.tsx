import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";

const ECG_PATH =
  "M0 100 L60 100 L80 100 L90 118 L108 42 L126 138 L144 100 L220 100 L240 100 L250 114 L265 50 L280 132 L295 100 L380 100 L400 100 L410 118 L428 42 L446 138 L464 100 L540 100 L560 100 L570 114 L585 50 L600 132 L615 100 L700 100 L720 100 L730 118 L748 42 L766 138 L784 100 L860 100 L880 100 L890 114 L905 50 L920 132 L935 100 L1020 100 L1040 100 L1050 118 L1068 42 L1086 138 L1104 100 L1200 100 L1260 100 L1280 100 L1290 118 L1308 42 L1326 138 L1344 100 L1420 100 L1440 100 L1450 114 L1465 50 L1480 132 L1495 100 L1580 100 L1600 100 L1610 118 L1628 42 L1646 138 L1664 100 L1740 100 L1760 100 L1770 114 L1785 50 L1800 132 L1815 100 L1900 100 L1920 100 L1930 118 L1948 42 L1966 138 L1984 100 L2060 100 L2080 100 L2090 114 L2105 50 L2120 132 L2135 100 L2220 100 L2240 100 L2250 118 L2268 42 L2286 138 L2304 100 L2400 100";

const STATS = [
  { value: "600+", label: "Live connectors", tag: "Live" },
  { value: "< 8s", label: "Question to chart", tag: "Median" },
  { value: "5 min", label: "To first insight", tag: "Setup" },
];

export function MarketingHero() {
  return (
    <section className="relative overflow-hidden pt-28 pb-24 sm:pt-32 sm:pb-28 lg:pt-40 lg:pb-32">
      <div className="container-page relative w-full">
        {/* Centered narrative block — eyebrow, headline, sub, CTAs.
            Single column, centered alignment. Apple/Linear/Umbrel
            convention: one focused voice, no competing right column. */}
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-accent-subtle px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
            <span className="live-dot" />
            AI Data Agent — Early Access
          </span>

          <h1 className="mt-8 text-[44px] font-semibold leading-[1.02] tracking-[-0.03em] text-text-primary sm:text-[68px] lg:text-[92px] font-heading">
            Talk to your
            <br />
            <span className="bg-gradient-to-br from-accent via-accent to-accent-hover bg-clip-text text-transparent">
              business data
            </span>
            <span className="text-accent">.</span>
          </h1>

          <p className="mx-auto mt-8 max-w-[640px] text-[17px] leading-[1.65] text-text-secondary sm:text-[19px] lg:text-[20px]">
            Liveli connects your data sources, runs the warehouse for you,
            and gives your team an AI analyst that answers questions and
            builds dashboards in plain English. No SQL, no BI tickets, no
            data engineer required.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3.5 text-[15px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_28px_var(--accent-glow-strong)] hover:scale-[1.02] active:scale-[0.98]"
            >
              Get started free
              <ArrowRightIcon />
            </Link>
            <Link
              href="/#how-it-works"
              className="inline-flex items-center gap-2 rounded-full border border-border px-6 py-3.5 text-[15px] font-medium text-text-primary transition-colors hover:border-border-hover hover:bg-hover"
            >
              See how it works
            </Link>
          </div>
        </div>

        {/* ECG band — full-bleed inside the section, its own dedicated
            row. Visual divider between narrative (above) and proof
            (below). Brand motif as a transition, not a background
            overlay. */}
        <div className="relative mt-16 h-[88px] sm:mt-20 sm:h-[104px] lg:mt-24">
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
            Tightly grouped (gap-4), max-width capped so they don't
            sprawl on ultra-wide displays. Boxes preserved per brand
            language — just laid out horizontally instead of stacked. */}
        <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-4 sm:mt-16 sm:grid-cols-3">
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
    <div className="card group flex items-center justify-between gap-4 p-6 transition-transform duration-300 hover:-translate-y-0.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-[32px] font-semibold leading-none tracking-tight text-accent tabular-nums font-heading">
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
