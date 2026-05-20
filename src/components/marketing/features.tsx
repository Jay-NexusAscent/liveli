import { ConnectIcon, ChatIcon, DashboardIcon, SparkleIcon, DatabaseIcon } from "@/components/icons";
import { ScrollReveal } from "./scroll-reveal";

const features = [
  {
    icon: ConnectIcon,
    title: "Connect anything",
    body:
      "Postgres, MySQL, Stripe, HubSpot, Salesforce, Google Ads, Shopify — 600+ sources powered by the open-source Meltano connector ecosystem. One click, one form, your data is live.",
  },
  {
    icon: ChatIcon,
    title: "Ask, don't query",
    body:
      "Type a question in plain English. The agent reads your schemas, writes the SQL, runs it on the warehouse, and explains the answer with a chart. No more BI bottlenecks.",
  },
  {
    icon: DashboardIcon,
    title: "Dashboards that build themselves",
    body:
      "Save any chart from a chat into a dashboard. Or describe the dashboard you want — \"weekly revenue by region, with last-quarter comparison\" — and Liveli builds it.",
  },
];

const steps = [
  { icon: DatabaseIcon, title: "Connect", body: "Pick a source, paste credentials, watch your tables sync." },
  { icon: SparkleIcon, title: "Ask", body: "Open the chat. Ask anything about your data, get a chart back." },
  { icon: DashboardIcon, title: "Share", body: "Pin charts to a dashboard. Invite your team. Done." },
];

export function MarketingFeatures() {
  return (
    <>
      <section id="features" className="container-page py-28 sm:py-32">
        <ScrollReveal>
          <div className="mx-auto mb-16 max-w-2xl text-center">
            <span className="mb-4 inline-block rounded-full bg-accent-subtle px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-accent">
              What you get
            </span>
            <h2 className="text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] text-text-primary font-heading sm:text-[44px]">
              One product, the whole data stack.
            </h2>
            <p className="mt-5 text-[16px] leading-[1.6] text-text-secondary sm:text-[17px]">
              Most teams cobble together a warehouse, an ingestion tool, a BI dashboard, and a
              data analyst. Liveli is all of that in one tab.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid gap-5 md:grid-cols-3">
          {features.map((f, i) => (
            <ScrollReveal key={f.title} delay={i * 100}>
              <div className="card group relative flex h-full flex-col overflow-hidden p-7 transition-transform duration-300 hover:-translate-y-0.5">
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent to-transparent opacity-30 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-muted text-accent">
                  <f.icon className="text-accent" />
                </div>
                <h3 className="mb-2 text-[18px] font-semibold tracking-tight text-text-primary font-heading">{f.title}</h3>
                <p className="text-[14px] leading-relaxed text-text-secondary">{f.body}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="container-page py-28 sm:py-32">
        <ScrollReveal>
          <div className="mx-auto mb-16 max-w-2xl text-center">
            <span className="mb-4 inline-block rounded-full bg-accent-subtle px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-accent">
              How it works
            </span>
            <h2 className="text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] text-text-primary font-heading sm:text-[44px]">
              From zero to dashboard in three steps.
            </h2>
          </div>
        </ScrollReveal>

        <div className="relative grid gap-5 md:grid-cols-3">
          {/* Connecting line through the icon row — solid bgs on the
              cards mask it where the cards sit, so the line is visible
              only in the gap-5 gaps between cards. Reads as "01 → 02
              → 03 progression" without adding any chrome on the cards
              themselves. Hidden on mobile (single column stack). */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-12 top-12 hidden h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent md:block"
          />
          {steps.map((s, i) => (
            <ScrollReveal key={s.title} delay={i * 100}>
              <div className="card-elevated relative h-full p-7">
                <div className="mb-5 flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-muted text-accent">
                    <s.icon className="text-accent" />
                  </div>
                  <span className="text-[13px] font-mono text-text-tertiary tabular-nums">0{i + 1}</span>
                </div>
                <h3 className="mb-2 text-[18px] font-semibold tracking-tight text-text-primary font-heading">{s.title}</h3>
                <p className="text-[14px] leading-relaxed text-text-secondary">{s.body}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </section>
    </>
  );
}
