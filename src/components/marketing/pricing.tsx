import Link from "next/link";
import { cn } from "@/lib/utils";
import { ArrowRightIcon, SparkleIcon } from "@/components/icons";

interface Tier {
  /** Display name */
  name: string;
  /** Monthly price in GBP. Null for custom. */
  priceGbp: number | null;
  /** Sub-headline under the name */
  tagline: string;
  /** Headline bullet under the price */
  highlight: string;
  /** Hard limits + included features */
  features: string[];
  /** CTA label + href */
  cta: { label: string; href: string };
  /** Visual emphasis flag */
  emphasis?: "popular" | "enterprise";
}

const tiers: Tier[] = [
  {
    name: "Free Trial",
    priceGbp: 0,
    tagline: "7 days, no card",
    highlight: "Full Pro tier experience.",
    features: [
      "1 data source",
      "Up to 10,000 rows ingested",
      "50 AI queries",
      "1 sync per day",
      "All Pro features unlocked",
    ],
    cta: { label: "Start free", href: "/sign-up" },
  },
  {
    name: "Growth",
    priceGbp: 49,
    tagline: "For lean teams getting started",
    highlight: "Daily refreshes, conversational charts.",
    features: [
      "Up to 3 data sources",
      "50,000 row warehouse cap",
      "Daily automated refreshes",
      "Unlimited conversational charts",
    ],
    cta: { label: "Choose Growth", href: "/sign-up?plan=growth" },
  },
  {
    name: "Pro",
    priceGbp: 149,
    tagline: "The sweet spot",
    highlight: "Hourly refreshes for production teams.",
    features: [
      "Up to 5 data sources",
      "500,000 row warehouse cap",
      "Hourly automated refreshes",
      "Priority agent inference",
    ],
    cta: { label: "Choose Pro", href: "/sign-up?plan=pro" },
    emphasis: "popular",
  },
  {
    name: "Scale",
    priceGbp: 399,
    tagline: "High-volume operators",
    highlight: "15-minute syncs, priority queues.",
    features: [
      "Unlimited data sources",
      "5,000,000 row warehouse cap",
      "15-minute sync intervals",
      "Full Predictive ML suite",
      "Priority processing queues",
    ],
    cta: { label: "Choose Scale", href: "/sign-up?plan=scale" },
  },
  {
    name: "Enterprise",
    priceGbp: null,
    tagline: "Bespoke pricing",
    highlight: "Dedicated resources, custom SLAs.",
    features: [
      "Custom warehouse scaling",
      "Dedicated resource reservations",
      "Custom data-retention pipelines",
      "Bespoke SLA guarantees",
      "On-premise + custom API connections",
    ],
    cta: { label: "Contact sales", href: "mailto:hello@liveli.co.uk?subject=Enterprise%20enquiry" },
    emphasis: "enterprise",
  },
];

function formatPrice(priceGbp: number | null): string {
  if (priceGbp === null) return "Custom";
  if (priceGbp === 0) return "£0";
  return `£${priceGbp}`;
}

export function MarketingPricing() {
  return (
    <section id="pricing" className="container-page py-28 sm:py-32">
      <div className="mx-auto mb-16 max-w-2xl text-center">
        <span className="mb-4 inline-block rounded-full bg-accent-subtle px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-accent">
          Pricing
        </span>
        <h2 className="text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] text-text-primary font-heading sm:text-[44px]">
          Pricing that scales with you.
        </h2>
        <p className="mt-5 text-[16px] leading-[1.6] text-text-secondary sm:text-[17px]">
          Start free. Upgrade when you outgrow the limits. No credit card to begin.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={cn(
              "card flex flex-col p-6 transition-transform duration-300 hover:-translate-y-0.5",
              tier.emphasis === "popular" &&
                "ring-2 ring-accent shadow-[0_0_36px_var(--accent-glow-strong)] lg:-translate-y-3 lg:hover:-translate-y-4",
              tier.emphasis === "enterprise" && "bg-elevated"
            )}
          >
            {tier.emphasis === "popular" && (
              <div className="mb-4 inline-flex w-fit items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-inverted">
                <SparkleIcon className="text-text-inverted" />
                Most popular
              </div>
            )}

            <h3 className="text-[18px] font-semibold tracking-tight text-text-primary font-heading">
              {tier.name}
            </h3>
            <p className="mt-1 text-[13px] text-text-tertiary">{tier.tagline}</p>

            <div className="mt-5 flex items-baseline gap-1">
              <span className="text-[32px] font-semibold tracking-tight text-text-primary font-heading tabular-nums">
                {formatPrice(tier.priceGbp)}
              </span>
              {tier.priceGbp !== null && tier.priceGbp > 0 && (
                <span className="text-[13px] text-text-tertiary">/month</span>
              )}
            </div>

            <p className="mt-3 text-[13px] font-medium text-text-secondary">
              {tier.highlight}
            </p>

            <ul className="mt-5 flex flex-col gap-2.5 border-t border-border-subtle pt-5">
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-[13px] leading-relaxed text-text-secondary">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <Link
              href={tier.cta.href}
              className={cn(
                "mt-auto inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2.5 text-[13px] font-medium transition-all",
                tier.emphasis === "popular"
                  ? "bg-accent text-text-inverted hover:bg-accent-hover hover:shadow-[0_0_20px_var(--accent-glow-strong)]"
                  : "border border-border text-text-primary hover:border-accent hover:text-accent",
                "mt-6"
              )}
            >
              {tier.cta.label}
              <ArrowRightIcon />
            </Link>
          </div>
        ))}
      </div>

      <p className="mt-10 text-center text-[12px] text-text-tertiary">
        All plans include EU data residency, fully managed BigQuery warehouse, and unlimited team members.
        Prices in GBP, billed monthly.
      </p>
    </section>
  );
}
