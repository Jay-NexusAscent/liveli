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

interface ConnectorRecord {
  id: string;
  name: string;
  type: string;
  status: string;
  lastError?: string;
  syncFrequency?: "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";
  /** True when the Cloud Scheduler job is paused — recurring syncs
   * suppressed. Manual "Sync now" and Fresh Ingest still work. */
  paused?: boolean;
  /** Firestore Timestamp shape: { _seconds, _nanoseconds } when serialized. */
  lastSyncFinishedAt?: { _seconds: number; _nanoseconds?: number };
  /** Duration of the most recent successful sync, ms. (Tier 1) */
  lastSyncDurationMs?: number;
  /** Rolling average of the last 5 successful syncs, ms. (Tier 1) */
  typicalSyncDurationMs?: number;
  // Editable connection metadata (non-sensitive — password lives in Secret Manager).
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  schemas?: string;
}

/**
 * Live-progress response shape from /api/connections/[id]/progress.
 * Polled every ~3s while a connector is in "syncing" state.
 */
interface ProgressResponse {
  state: "idle" | "syncing";
  phase?: "starting" | "discovery" | "extracting" | "loading" | "finalising" | "unknown";
  recordsProcessed?: number;
  elapsedMs?: number;
  typicalMs?: number | null;
  percent?: number | null;
  latestLogLine?: string | null;
}

const PHASE_LABELS: Record<NonNullable<ProgressResponse["phase"]>, string> = {
  starting: "Starting up",
  discovery: "Discovering schema",
  extracting: "Reading from source",
  loading: "Writing to warehouse",
  finalising: "Finalising",
  unknown: "Syncing",
};

/** Render a millisecond duration as "47s" / "1m 23s" / "2h 14m". */
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
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
  /** Connector currently transitioning paused state — used to disable
   * the Pause button while the API call is in flight. */
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ConnectorRecord | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<SourceCategory | "All">("All");
  // Live per-connector progress, keyed by connectorId. Populated by the
  // polling effect below for any connector in "syncing" state.
  const [progressById, setProgressById] = useState<Record<string, ProgressResponse>>({});

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

  // Poll the per-connector progress endpoint while any connectors are
  // syncing. Cheap (~one Cloud Logging read per call) and only runs when
  // there's something to track. Clears the map entry once a connector
  // leaves the syncing state so stale progress doesn't linger.
  useEffect(() => {
    const syncing = connectors.filter((c) => c.status === "syncing");
    if (syncing.length === 0) {
      setProgressById((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    let cancelled = false;
    const pollOnce = async () => {
      const results = await Promise.all(
        syncing.map(async (c) => {
          try {
            const res = await fetch(`/api/connections/${c.id}/progress`);
            if (!res.ok) return null;
            const data = (await res.json()) as ProgressResponse;
            return [c.id, data] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      setProgressById((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (!r) continue;
          if (r[1].state === "idle") {
            delete next[r[0]];
          } else {
            next[r[0]] = r[1];
          }
        }
        return next;
      });
    };
    pollOnce();
    const id = setInterval(pollOnce, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connectors]);

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

  const togglePause = async (connectorId: string, paused: boolean) => {
    setPausingId(connectorId);
    setError(null);
    try {
      const res = await fetch(`/api/connections/${connectorId}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Server returns BOTH a friendly `error` ("Couldn't pause...")
        // and the technical `errorMessage` (the underlying SDK error).
        // Display both when they differ — saves a round trip through
        // GCP audit logs to figure out what went wrong.
        const friendly = data.error as string | undefined;
        const technical = data.errorMessage as string | undefined;
        const composed =
          friendly && technical && friendly !== technical
            ? `${friendly}\n${technical}`
            : friendly ?? technical ?? `HTTP ${res.status}`;
        throw new Error(composed);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPausingId(null);
    }
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
            {connectors.map((c) => {
              const prog = progressById[c.id];
              const isSyncing = c.status === "syncing";
              return (
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
                      {/* Tier 1: typical sync duration (rolling avg of last 5
                          successful runs). Only shown when we have history. */}
                      {c.typicalSyncDurationMs && c.typicalSyncDurationMs > 0 && !isSyncing && (
                        <>
                          <span className="text-text-tertiary">·</span>
                          <span title="Rolling average of the last 5 successful syncs">
                            typical {formatDuration(c.typicalSyncDurationMs)}
                          </span>
                        </>
                      )}
                    </div>
                    {/* Tier 3: live progress shown only while syncing. */}
                    {isSyncing && prog?.state === "syncing" && (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-accent">
                            {PHASE_LABELS[prog.phase ?? "unknown"]}
                            {prog.recordsProcessed
                              ? ` · ${prog.recordsProcessed.toLocaleString()} records`
                              : ""}
                          </span>
                          <span className="font-mono tabular-nums text-text-tertiary">
                            {formatDuration(prog.elapsedMs ?? 0)}
                            {prog.typicalMs ? ` / ~${formatDuration(prog.typicalMs)}` : ""}
                          </span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-border-subtle">
                          <div
                            className="h-full rounded-full bg-accent transition-all duration-1000"
                            style={{
                              width:
                                prog.percent != null
                                  ? `${prog.percent}%`
                                  : // no typical history yet — show a slow
                                    // indeterminate-ish bar based on elapsed
                                    `${Math.min(95, Math.floor((prog.elapsedMs ?? 0) / 1000))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {/* Suppress lastError while paused — the connector
                        is intentionally not running, so the previous
                        failure isn't actionable until the user resumes.
                        Firestore still holds it; it'll re-appear once
                        the connector is resumed and (if it errors
                        again) the sync route writes a fresh lastError. */}
                    {c.lastError && !c.paused && (
                      <div className="mt-2 line-clamp-2 text-[11px] text-[color:var(--status-error)]">
                        {c.lastError}
                      </div>
                    )}
                  </div>
                  {/* Paused IS the status while paused — replace the
                      synced/error badge rather than rendering alongside.
                      The connector's underlying `status` field (synced /
                      error / etc.) is preserved in Firestore and shows
                      again the moment it's resumed. */}
                  <StatusBadge
                    status={c.paused ? "paused" : c.status}
                    title={
                      c.paused
                        ? "Scheduled syncs are paused. Click Resume to re-enable, or Sync now to run a one-off."
                        : undefined
                    }
                  />
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
                    onClick={() => togglePause(c.id, !c.paused)}
                    disabled={pausingId === c.id}
                    className={cn(
                      "rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary",
                      pausingId === c.id && "opacity-60"
                    )}
                    title={c.paused ? "Resume scheduled syncs" : "Pause scheduled syncs (manual sync still works)"}
                  >
                    {pausingId === c.id
                      ? c.paused
                        ? "Resuming…"
                        : "Pausing…"
                      : c.paused
                        ? "Resume"
                        : "Pause"}
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
                </div>
              </div>
              );
            })}
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
        onDeleted={() => {
          setEditing(null);
          refresh();
        }}
      />
    </div>
  );
}

function StatusBadge({
  status,
  title,
}: {
  status: string;
  /** Optional hover tooltip — used by the "paused" variant to explain
   * the state ("scheduled syncs paused…") without taking up space in
   * the card chrome. */
  title?: string;
}) {
  const map: Record<string, { label: string; classes: string }> = {
    synced: { label: "Synced", classes: "bg-[color:var(--status-success)]/15 text-[color:var(--status-success)]" },
    syncing: { label: "Syncing", classes: "bg-accent-muted text-accent" },
    configured: { label: "Configured", classes: "bg-hover text-text-secondary" },
    error: { label: "Error", classes: "bg-[color:var(--status-error)]/15 text-[color:var(--status-error)]" },
    // Paused is a first-class status, not a sub-state — it replaces
    // synced/error/etc. on the badge while c.paused is true, and the
    // lastError text is suppressed alongside (see the card body above).
    // Visual: muted background (the connector is intentionally idle, not
    // failing), distinct from `configured` only by label. The Pause /
    // Resume button on the card disambiguates intent.
    paused: { label: "Paused", classes: "bg-hover text-text-secondary" },
  };
  const v = map[status] ?? { label: status, classes: "bg-hover text-text-secondary" };
  return (
    <span
      title={title}
      className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider", v.classes)}
    >
      {v.label}
    </span>
  );
}
