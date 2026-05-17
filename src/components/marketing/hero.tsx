import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";

export function MarketingHero() {
  return (
    <section className="relative overflow-hidden pt-24 pb-20 sm:pt-28 sm:pb-24">
      {/* Animated ECG line backdrop */}
      <svg
        className="hero-ecg absolute inset-x-0 top-1/2 -z-10 h-40 w-full -translate-y-1/2"
        viewBox="0 0 2400 200"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M0 100 L60 100 L80 100 L90 118 L108 42 L126 138 L144 100 L220 100 L240 100 L250 114 L265 50 L280 132 L295 100 L380 100 L400 100 L410 118 L428 42 L446 138 L464 100 L540 100 L560 100 L570 114 L585 50 L600 132 L615 100 L700 100 L720 100 L730 118 L748 42 L766 138 L784 100 L860 100 L880 100 L890 114 L905 50 L920 132 L935 100 L1020 100 L1040 100 L1050 118 L1068 42 L1086 138 L1104 100 L1200 100 L1260 100 L1280 100 L1290 118 L1308 42 L1326 138 L1344 100 L1420 100 L1440 100 L1450 114 L1465 50 L1480 132 L1495 100 L1580 100 L1600 100 L1610 118 L1628 42 L1646 138 L1664 100 L1740 100 L1760 100 L1770 114 L1785 50 L1800 132 L1815 100 L1900 100 L1920 100 L1930 118 L1948 42 L1966 138 L1984 100 L2060 100 L2080 100 L2090 114 L2105 50 L2120 132 L2135 100 L2220 100 L2240 100 L2250 118 L2268 42 L2286 138 L2304 100 L2400 100" />
      </svg>

      <div className="container-page grid items-start gap-10 lg:grid-cols-[1.25fr_1fr]">
        <div>
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-accent-subtle px-3 py-1 text-[12px] font-medium uppercase tracking-wider text-text-secondary">
            <span className="live-dot" />
            AI Data Agent — Early Access
          </span>

          <h1 className="text-[44px] font-semibold leading-[1.05] tracking-tight text-text-primary sm:text-[60px] lg:text-[68px] font-heading">
            Talk to your <span className="text-accent">business data</span>.
          </h1>

          <p className="mt-6 max-w-xl text-[18px] leading-relaxed text-text-secondary">
            Liveli connects your data sources, runs the warehouse for you, and gives your team
            an AI analyst that answers questions and builds dashboards in plain English. No SQL,
            no BI tickets, no data engineer required.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href="/sign-up"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-3 text-[15px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_24px_var(--accent-glow-strong)]"
            >
              Get started free
              <ArrowRightIcon />
            </Link>
            <Link
              href="/#how-it-works"
              className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-3 text-[15px] font-medium text-text-primary transition-colors hover:border-border-hover hover:bg-hover"
            >
              See how it works
            </Link>
          </div>
        </div>

        <div className="grid gap-4">
          <StatCard label="Connectors" value="600+" tag="Live" />
          <StatCard label="Questions to chart" value="< 8s" tag="Median" />
          <StatCard label="Setup time" value="5 min" tag="To first insight" />
        </div>
      </div>
    </section>
  );
}

function StatCard({ label, value, tag }: { label: string; value: string; tag: string }) {
  return (
    <div className="card p-5 transition-transform duration-300 hover:-translate-y-0.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[28px] font-semibold text-accent tabular-nums">{value}</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{tag}</span>
      </div>
      <div className="mt-1 text-[14px] text-text-secondary">{label}</div>
    </div>
  );
}
