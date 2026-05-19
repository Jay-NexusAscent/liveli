"use client";

import { useEffect, useState } from "react";
import { ConnectIcon, DatabaseIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { PostgresWizard } from "@/components/connections/postgres-wizard";
import { MysqlWizard } from "@/components/connections/mysql-wizard";
import { StripeWizard } from "@/components/connections/stripe-wizard";
import { ShopifyWizard } from "@/components/connections/shopify-wizard";
import { HubspotWizard } from "@/components/connections/hubspot-wizard";
import { GoogleAdsWizard } from "@/components/connections/google-ads-wizard";
import { FacebookAdsWizard } from "@/components/connections/facebook-ads-wizard";
import { SalesforceWizard } from "@/components/connections/salesforce-wizard";
import { MailchimpWizard } from "@/components/connections/mailchimp-wizard";
import { EditConnectorModal } from "@/components/connections/edit-connector-modal";
import { ConfirmModal } from "@/components/ui/confirm-modal";

interface ConnectorRecord {
  id: string;
  name: string;
  type: string;
  status: string;
  lastError?: string;
  syncFrequency?: "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";
  /** Firestore Timestamp shape: { _seconds, _nanoseconds } when serialized. */
  lastSyncFinishedAt?: { _seconds: number; _nanoseconds?: number };
  // Editable connection metadata (non-sensitive — password lives in Secret Manager).
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  schemas?: string;
}

/** Render a Firestore timestamp as a human "x minutes ago" string. */
function formatLastSynced(
  ts: ConnectorRecord["lastSyncFinishedAt"]
): string {
  if (!ts || typeof ts._seconds !== "number") return "Never";
  const ms = ts._seconds * 1000;
  const diff = Date.now() - ms;
  if (diff < 0) return "Just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  // Older than a week — show the date instead of "23d ago".
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const SYNC_FREQUENCY_LABELS: Record<NonNullable<ConnectorRecord["syncFrequency"]>, string> = {
  "5m": "every 5 min",
  "15m": "every 15 min",
  "30m": "every 30 min",
  "1h": "hourly",
  "6h": "every 6h",
  "12h": "every 12h",
  "24h": "daily",
};

// One enum value per wizard. When a source tile is clicked we set
// `activeWizard` to its action and the corresponding wizard mounts. The
// strings must match the `type` field the connect route writes to the
// connector doc, since the sync env-mapping switch keys off the same.
type ConnectAction =
  | "postgres"
  | "mysql"
  | "stripe"
  | "shopify"
  | "hubspot"
  | "google-ads"
  | "facebook-ads"
  | "salesforce"
  | "mailchimp"
  | null;

type SourceCategory =
  | "Databases"
  | "Payments"
  | "E-commerce"
  | "CRM"
  | "Marketing"
  | "Analytics"
  | "Project Management"
  | "Support"
  | "Finance"
  | "Productivity";

const CATEGORIES: SourceCategory[] = [
  "Databases",
  "Payments",
  "E-commerce",
  "CRM",
  "Marketing",
  "Analytics",
  "Project Management",
  "Support",
  "Finance",
  "Productivity",
];

interface PopularSource {
  name: string;
  desc: string;
  category: SourceCategory;
  action: ConnectAction;
}

// Top 50 Meltano connectors — well-supported taps in the data-engineering
// ecosystem that the typical Liveli prospect is most likely to ask for.
// Anything with action: null shows a "Coming soon" CTA until we ship the
// connect wizard for that source type.
const popularSources: PopularSource[] = [
  // Databases
  { name: "PostgreSQL", desc: "Replicate tables from any Postgres database", category: "Databases", action: "postgres" },
  { name: "MySQL", desc: "Replicate tables from any MySQL database", category: "Databases", action: "mysql" },
  { name: "BigQuery", desc: "Replicate datasets from your BigQuery project", category: "Databases", action: null },
  { name: "MongoDB", desc: "Sync collections from MongoDB or Atlas", category: "Databases", action: null },
  { name: "Snowflake", desc: "Replicate tables from your Snowflake warehouse", category: "Databases", action: null },
  { name: "Amazon Redshift", desc: "Replicate tables from a Redshift cluster", category: "Databases", action: null },
  { name: "Oracle Database", desc: "Replicate tables from an Oracle DB", category: "Databases", action: null },
  { name: "Microsoft SQL Server", desc: "Replicate tables from MSSQL / Azure SQL", category: "Databases", action: null },
  { name: "MariaDB", desc: "Replicate tables from any MariaDB instance", category: "Databases", action: null },
  { name: "DuckDB", desc: "Replicate from a DuckDB file or motherduck", category: "Databases", action: null },

  // Payments
  { name: "Stripe", desc: "Charges, subscriptions, customers, refunds", category: "Payments", action: "stripe" },
  { name: "PayPal", desc: "Transactions, disputes, payouts", category: "Payments", action: null },
  { name: "Chargebee", desc: "Subscription billing + revenue events", category: "Payments", action: null },
  { name: "Recurly", desc: "Subscriptions, invoices, accounts", category: "Payments", action: null },
  { name: "Square", desc: "Transactions, items, customers, payouts", category: "Payments", action: null },

  // E-commerce
  { name: "Shopify", desc: "Orders, products, customers, inventory", category: "E-commerce", action: "shopify" },
  { name: "WooCommerce", desc: "Orders, products, customers from your WP store", category: "E-commerce", action: null },
  { name: "BigCommerce", desc: "Orders, catalog, customers, fulfilment", category: "E-commerce", action: null },
  { name: "Adobe Commerce", desc: "Magento / Adobe Commerce orders + catalog", category: "E-commerce", action: null },
  { name: "Amazon Seller", desc: "Orders, fulfilment, settlements, fees", category: "E-commerce", action: null },

  // CRM
  { name: "HubSpot", desc: "Contacts, deals, companies, engagements", category: "CRM", action: "hubspot" },
  { name: "Salesforce", desc: "Accounts, opportunities, contacts, leads", category: "CRM", action: "salesforce" },
  { name: "Pipedrive", desc: "Pipelines, deals, activities, persons", category: "CRM", action: null },
  { name: "Zendesk Sell", desc: "Pipeline, contacts, deals", category: "CRM", action: null },
  { name: "Close", desc: "Leads, opportunities, calls, emails", category: "CRM", action: null },

  // Marketing
  { name: "Google Ads", desc: "Campaign performance and spend", category: "Marketing", action: "google-ads" },
  { name: "Meta Ads", desc: "Facebook + Instagram ad performance", category: "Marketing", action: "facebook-ads" },
  { name: "LinkedIn Ads", desc: "Sponsored content + lead-gen campaigns", category: "Marketing", action: null },
  { name: "TikTok Ads", desc: "TikTok ad performance + creatives", category: "Marketing", action: null },
  { name: "Microsoft Ads", desc: "Bing search ads performance + spend", category: "Marketing", action: null },
  { name: "Mailchimp", desc: "Campaigns, lists, audience engagement", category: "Marketing", action: "mailchimp" },
  { name: "Klaviyo", desc: "Email + SMS flows, lists, events", category: "Marketing", action: null },
  { name: "ActiveCampaign", desc: "Automations, deals, contacts", category: "Marketing", action: null },

  // Analytics
  { name: "Google Analytics 4", desc: "Sessions, events, conversions", category: "Analytics", action: null },
  { name: "Mixpanel", desc: "Product events + funnels", category: "Analytics", action: null },
  { name: "Amplitude", desc: "Product events + cohorts", category: "Analytics", action: null },
  { name: "Segment", desc: "Customer events from any Segment source", category: "Analytics", action: null },

  // Project Management
  { name: "Jira", desc: "Issues, sprints, projects, worklogs", category: "Project Management", action: null },
  { name: "Asana", desc: "Tasks, projects, teams, time tracking", category: "Project Management", action: null },
  { name: "Linear", desc: "Issues, cycles, projects, teams", category: "Project Management", action: null },
  { name: "Notion", desc: "Databases, pages, blocks", category: "Project Management", action: null },

  // Support
  { name: "Intercom", desc: "Conversations, contacts, tags, segments", category: "Support", action: null },
  { name: "Zendesk Support", desc: "Tickets, users, organizations, SLAs", category: "Support", action: null },
  { name: "Freshdesk", desc: "Tickets, agents, conversations", category: "Support", action: null },

  // Finance
  { name: "QuickBooks", desc: "Invoices, P&L, accounts, customers", category: "Finance", action: null },
  { name: "Xero", desc: "Invoices, contacts, balance sheet, P&L", category: "Finance", action: null },
  { name: "Sage Intacct", desc: "GL, AR/AP, vendors, customers", category: "Finance", action: null },

  // Productivity
  { name: "Slack", desc: "Messages, channels, users, files", category: "Productivity", action: null },
  { name: "GitHub", desc: "Issues, PRs, commits, releases", category: "Productivity", action: null },
  { name: "Google Sheets", desc: "Sync any spreadsheet as a table", category: "Productivity", action: null },
];

export default function ConnectionsPage() {
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  // One wizard at a time — clicking a tile sets this to its action,
  // each wizard's onClose clears it. Cleaner than 9 boolean flags.
  const [activeWizard, setActiveWizard] = useState<ConnectAction>(null);
  const closeWizard = () => setActiveWizard(null);
  const onWizardConnected = () => {
    refresh();
  };
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConnectorRecord | null>(null);
  const [editing, setEditing] = useState<ConnectorRecord | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<SourceCategory | "All">("All");

  const refresh = async () => {
    try {
      const res = await fetch("/api/connectors");
      if (res.ok) {
        const data = await res.json();
        setConnectors(data.items ?? []);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const triggerSync = async (connectorId: string) => {
    setSyncingId(connectorId);
    setError(null);
    try {
      const res = await fetch(`/api/connections/${connectorId}/sync`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setError(null);
    const res = await fetch(`/api/connections/${pendingDelete.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(
        data.errorMessage
          ? `${data.error ?? "Delete failed"}\n${data.errorMessage}`
          : data.error ?? `HTTP ${res.status}`
      );
    }
    setPendingDelete(null);
    await refresh();
  };

  return (
    <div className="container-page py-8">
      <header className="mb-8">
        <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">Connections</h1>
        <p className="mt-1 text-[14px] text-text-secondary">
          Wire up the systems that power your business. Liveli runs the ingestion, manages
          the warehouse, and keeps your data fresh.
        </p>
      </header>

      {error && (
        <div className="mb-6 whitespace-pre-wrap rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-4 py-2 text-[12px] text-[color:var(--status-error)]">
          {error}
        </div>
      )}

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
                <p className="text-[15px] font-medium text-text-primary">No sources connected yet</p>
                <p className="mt-0.5 text-[13px] text-text-secondary">
                  Pick a source below to get started — Liveli will replicate it into BigQuery for you.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
          >
            {connectors.map((c) => (
              <div key={c.id} className="card-elevated flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-text-primary">{c.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-secondary">
                      <span>{c.type}</span>
                      {c.syncFrequency && (
                        <>
                          <span className="text-text-tertiary">·</span>
                          <span>syncs {SYNC_FREQUENCY_LABELS[c.syncFrequency]}</span>
                        </>
                      )}
                      <span className="text-text-tertiary">·</span>
                      <span title={c.lastSyncFinishedAt ? new Date(c.lastSyncFinishedAt._seconds * 1000).toLocaleString() : "Never synced"}>
                        {/* When status is error, label as 'last attempt' since the sync didn't actually succeed. */}
                        {c.status === "error" ? "last attempt" : "last sync"}: {formatLastSynced(c.lastSyncFinishedAt)}
                      </span>
                    </div>
                    {c.lastError && (
                      <div className="mt-2 line-clamp-2 text-[11px] text-[color:var(--status-error)]">
                        {c.lastError}
                      </div>
                    )}
                  </div>
                  <StatusBadge status={c.status} />
                </div>

                <div className="flex items-center justify-end gap-1.5 border-t border-border pt-2">
                  <button
                    type="button"
                    onClick={() => setEditing(c)}
                    className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerSync(c.id)}
                    disabled={syncingId === c.id || c.status === "syncing"}
                    className={cn(
                      "rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary",
                      (syncingId === c.id || c.status === "syncing") && "opacity-60"
                    )}
                  >
                    {syncingId === c.id || c.status === "syncing" ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(c)}
                    className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-[color:var(--status-error)]/40 hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)]"
                    title="Delete connector"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
              Popular sources
            </h2>
            <p className="mt-1 text-[12px] text-text-tertiary">
              {popularSources.length} sources available — more added weekly.
            </p>
          </div>

          {/* Search box */}
          <div className="relative w-full sm:w-72">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sources…"
              className="w-full rounded-md border border-border bg-elevated px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>

        {/* Category filter chips — horizontally scrollable on mobile. */}
        <div className="mb-5 -mx-1 flex gap-1.5 overflow-x-auto pb-1">
          {(["All", ...CATEGORIES] as const).map((cat) => {
            const isActive = filterCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setFilterCategory(cat as SourceCategory | "All")}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
                  isActive
                    ? "bg-accent text-text-inverted"
                    : "border border-border bg-elevated text-text-secondary hover:border-accent hover:text-text-primary"
                )}
              >
                {cat}
              </button>
            );
          })}
        </div>

        {(() => {
          const q = search.trim().toLowerCase();
          const filtered = popularSources.filter((s) => {
            const matchCat =
              filterCategory === "All" || s.category === filterCategory;
            const matchSearch =
              !q ||
              s.name.toLowerCase().includes(q) ||
              s.desc.toLowerCase().includes(q) ||
              s.category.toLowerCase().includes(q);
            return matchCat && matchSearch;
          });

          if (filtered.length === 0) {
            return (
              <div className="rounded-lg border border-dashed border-border-subtle p-12 text-center">
                <p className="text-[14px] text-text-secondary">
                  No sources match{" "}
                  <span className="font-medium text-text-primary">
                    &ldquo;{search}&rdquo;
                  </span>
                  {filterCategory !== "All" && (
                    <>
                      {" "}
                      in <span className="font-medium text-text-primary">{filterCategory}</span>
                    </>
                  )}
                  .
                </p>
                <p className="mt-1 text-[12px] text-text-tertiary">
                  Try a different search, clear the category filter, or{" "}
                  <a
                    href="mailto:hello@liveli.co.uk?subject=Connector%20request"
                    className="text-accent hover:underline"
                  >
                    request a connector
                  </a>
                  .
                </p>
              </div>
            );
          }

          return (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((s) => {
                const interactive = s.action !== null;
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => {
                      if (s.action) setActiveWizard(s.action);
                    }}
                    disabled={!interactive}
                    className={cn(
                      "card group relative flex flex-col items-start p-5 text-left transition-all",
                      interactive
                        ? "cursor-pointer hover:-translate-y-0.5"
                        : "cursor-not-allowed opacity-50"
                    )}
                  >
                    <div className="mb-3 flex w-full items-center justify-between">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-subtle text-accent">
                        <DatabaseIcon className="text-accent" />
                      </div>
                      <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
                        {s.category}
                      </span>
                    </div>
                    <h3 className="mb-1 text-[15px] font-semibold text-text-primary font-heading">
                      {s.name}
                    </h3>
                    <p className="text-[13px] leading-relaxed text-text-secondary">
                      {s.desc}
                    </p>
                    <div className="mt-4 inline-flex items-center gap-1 text-[11px] font-medium">
                      {interactive ? (
                        <span className="text-accent">Connect →</span>
                      ) : (
                        <span className="text-text-tertiary">Coming soon</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })()}
      </section>

      <PostgresWizard
        open={activeWizard === "postgres"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <MysqlWizard
        open={activeWizard === "mysql"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <StripeWizard
        open={activeWizard === "stripe"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <ShopifyWizard
        open={activeWizard === "shopify"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <HubspotWizard
        open={activeWizard === "hubspot"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <GoogleAdsWizard
        open={activeWizard === "google-ads"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <FacebookAdsWizard
        open={activeWizard === "facebook-ads"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <SalesforceWizard
        open={activeWizard === "salesforce"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />
      <MailchimpWizard
        open={activeWizard === "mailchimp"}
        onClose={closeWizard}
        onConnected={onWizardConnected}
      />

      <EditConnectorModal
        connector={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          refresh();
        }}
      />

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete connector?"
        destructive
        confirmLabel="Delete connector"
        cancelLabel="Cancel"
        message={
          pendingDelete ? (
            <>
              <p>
                You&apos;re about to delete{" "}
                <span className="font-medium text-text-primary">
                  {pendingDelete.name}
                </span>
                . This will:
              </p>
              <ul className="mt-3 ml-5 list-disc space-y-1 text-[13px]">
                <li>Securely remove your stored connection credentials.</li>
                <li>Stop any future syncs for this source.</li>
                <li>
                  <span className="font-medium text-text-primary">
                    Permanently delete all replicated data
                  </span>{" "}
                  for this source — tables, history, and any charts that reference
                  them will no longer load.
                </li>
              </ul>
              <p className="mt-3 text-[12px] text-text-tertiary">This action cannot be undone.</p>
            </>
          ) : null
        }
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; classes: string }> = {
    synced: { label: "Synced", classes: "bg-[color:var(--status-success)]/15 text-[color:var(--status-success)]" },
    syncing: { label: "Syncing", classes: "bg-accent-muted text-accent" },
    configured: { label: "Configured", classes: "bg-hover text-text-secondary" },
    error: { label: "Error", classes: "bg-[color:var(--status-error)]/15 text-[color:var(--status-error)]" },
  };
  const v = map[status] ?? { label: status, classes: "bg-hover text-text-secondary" };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider", v.classes)}>
      {v.label}
    </span>
  );
}
