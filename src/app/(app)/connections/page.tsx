import { ConnectIcon, DatabaseIcon, ArrowRightIcon } from "@/components/icons";

const popularSources = [
  { name: "PostgreSQL", desc: "Replicate tables from any Postgres database", tag: "Database" },
  { name: "BigQuery", desc: "Query datasets directly without ingestion", tag: "Warehouse" },
  { name: "Stripe", desc: "Charges, subscriptions, customers, refunds", tag: "Payments" },
  { name: "HubSpot", desc: "Contacts, deals, companies, engagements", tag: "CRM" },
  { name: "Google Ads", desc: "Campaign performance and spend", tag: "Marketing" },
  { name: "Shopify", desc: "Orders, products, customers", tag: "E-commerce" },
];

export default function ConnectionsPage() {
  return (
    <div className="container-page py-8">
      <header className="mb-8">
        <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">Connections</h1>
        <p className="mt-1 text-[14px] text-text-secondary">
          Wire up the systems that power your business. Liveli runs the ingestion, manages the
          warehouse, and keeps your data fresh.
        </p>
      </header>

      <section className="mb-12">
        <h2 className="mb-4 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">Your sources</h2>
        <div className="card-elevated flex items-center justify-between gap-4 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-muted text-accent">
              <ConnectIcon className="text-accent" />
            </div>
            <div>
              <p className="text-[15px] font-medium text-text-primary">No sources connected yet</p>
              <p className="mt-0.5 text-[13px] text-text-secondary">Pick a source below to get started.</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
          Popular sources
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {popularSources.map((s) => (
            <button
              key={s.name}
              type="button"
              className="card group flex flex-col items-start p-5 text-left"
            >
              <div className="mb-3 flex w-full items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-subtle text-accent">
                  <DatabaseIcon className="text-accent" />
                </div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">{s.tag}</span>
              </div>
              <h3 className="mb-1 text-[15px] font-semibold text-text-primary font-heading">{s.name}</h3>
              <p className="text-[13px] leading-relaxed text-text-secondary">{s.desc}</p>
              <div className="mt-4 flex items-center gap-1.5 text-[12px] font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100">
                Connect
                <ArrowRightIcon />
              </div>
            </button>
          ))}
        </div>
        <p className="mt-6 text-center text-[12px] text-text-tertiary">
          600+ sources available via Meltano. Connector wiring is being built — Postgres lands first.
        </p>
      </section>
    </div>
  );
}
