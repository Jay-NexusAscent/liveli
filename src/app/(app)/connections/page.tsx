"use client";

import { useEffect, useState } from "react";
import { ConnectIcon, DatabaseIcon, ArrowRightIcon, SparkleIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

interface ConnectorRecord {
  id: string;
  name: string;
  type: string;
  status: string;
  tables?: string[];
}

const popularSources = [
  { name: "PostgreSQL", desc: "Replicate tables from any Postgres database", tag: "Database" },
  { name: "BigQuery", desc: "Query datasets directly without ingestion", tag: "Warehouse" },
  { name: "Stripe", desc: "Charges, subscriptions, customers, refunds", tag: "Payments" },
  { name: "HubSpot", desc: "Contacts, deals, companies, engagements", tag: "CRM" },
  { name: "Google Ads", desc: "Campaign performance and spend", tag: "Marketing" },
  { name: "Shopify", desc: "Orders, products, customers", tag: "E-commerce" },
];

export default function ConnectionsPage() {
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch("/api/connectors");
      if (res.ok) {
        const data = await res.json();
        setConnectors(data.items ?? []);
      }
    } catch {
      // ignore — endpoint may not exist yet
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const seedDemo = async () => {
    setSeeding(true);
    setError(null);
    try {
      const res = await fetch("/api/connections/seed-demo", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSeeding(false);
    }
  };

  const hasDemoConnector = connectors.some((c) => c.type === "demo");

  return (
    <div className="container-page py-8">
      <header className="mb-8">
        <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">
          Connections
        </h1>
        <p className="mt-1 text-[14px] text-text-secondary">
          Wire up the systems that power your business. Liveli runs the ingestion, manages
          the warehouse, and keeps your data fresh.
        </p>
      </header>

      {/* Try sample data callout */}
      {!hasDemoConnector && (
        <section className="card-elevated mb-10 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
              <SparkleIcon className="text-accent" />
            </div>
            <div>
              <h2 className="text-[15px] font-medium text-text-primary">
                Try with sample data
              </h2>
              <p className="mt-1 text-[13px] text-text-secondary">
                Instantly load the TheLook E-commerce dataset (users, products, orders,
                order_items, distribution_centers) so you can start chatting with the
                agent right away.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={seedDemo}
            disabled={seeding}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_20px_var(--accent-glow-strong)]",
              seeding && "opacity-60"
            )}
          >
            {seeding ? "Loading sample data…" : "Load sample data"}
            {!seeding && <ArrowRightIcon />}
          </button>
        </section>
      )}

      {error && (
        <div className="mb-6 rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-4 py-2 text-[13px] text-[color:var(--status-error)]">
          {error}
        </div>
      )}

      {/* Existing connectors */}
      <section className="mb-12">
        <h2 className="mb-4 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
          Your sources
        </h2>
        {connectors.length === 0 ? (
          <div className="card-elevated flex items-center justify-between gap-4 p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-muted text-accent">
                <ConnectIcon className="text-accent" />
              </div>
              <div>
                <p className="text-[15px] font-medium text-text-primary">
                  No sources connected yet
                </p>
                <p className="mt-0.5 text-[13px] text-text-secondary">
                  Click &ldquo;Load sample data&rdquo; above to get started instantly, or pick a
                  source below.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {connectors.map((c) => (
              <div key={c.id} className="card-elevated p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-medium text-text-primary">{c.name}</div>
                    <div className="mt-0.5 text-[12px] text-text-secondary">
                      {c.tables?.length ?? 0} table{(c.tables?.length ?? 0) === 1 ? "" : "s"}
                      {c.tables && c.tables.length > 0 && ` · ${c.tables.join(", ")}`}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                      c.status === "synced"
                        ? "bg-[color:var(--status-success)]/15 text-[color:var(--status-success)]"
                        : "bg-accent-subtle text-accent"
                    )}
                  >
                    {c.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
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
              disabled
              className="card group flex cursor-not-allowed flex-col items-start p-5 text-left opacity-60"
            >
              <div className="mb-3 flex w-full items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-subtle text-accent">
                  <DatabaseIcon className="text-accent" />
                </div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                  {s.tag}
                </span>
              </div>
              <h3 className="mb-1 text-[15px] font-semibold text-text-primary font-heading">
                {s.name}
              </h3>
              <p className="text-[13px] leading-relaxed text-text-secondary">{s.desc}</p>
              <div className="mt-4 text-[11px] text-text-tertiary">Coming soon</div>
            </button>
          ))}
        </div>
        <p className="mt-6 text-center text-[12px] text-text-tertiary">
          600+ sources available via Meltano. First real connector (Postgres) is being
          wired — see the backlog.
        </p>
      </section>
    </div>
  );
}
