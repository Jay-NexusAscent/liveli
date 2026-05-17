"use client";

import { useEffect, useState } from "react";
import { ConnectIcon, DatabaseIcon, ArrowRightIcon, SparkleIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { PostgresWizard } from "@/components/connections/postgres-wizard";
import { ConfirmModal } from "@/components/ui/confirm-modal";

interface ConnectorRecord {
  id: string;
  name: string;
  type: string;
  status: string;
  tables?: string[];
  lastError?: string;
}

type ConnectAction = "postgres" | null;

const popularSources: Array<{
  name: string;
  desc: string;
  tag: string;
  action: ConnectAction;
}> = [
  { name: "PostgreSQL", desc: "Replicate tables from any Postgres database", tag: "Database", action: "postgres" },
  { name: "MySQL", desc: "Replicate tables from any MySQL database", tag: "Database", action: null },
  { name: "BigQuery", desc: "Query datasets directly without ingestion", tag: "Warehouse", action: null },
  { name: "Stripe", desc: "Charges, subscriptions, customers, refunds", tag: "Payments", action: null },
  { name: "Shopify", desc: "Orders, products, customers, inventory", tag: "E-commerce", action: null },
  { name: "HubSpot", desc: "Contacts, deals, companies, engagements", tag: "CRM", action: null },
  { name: "Google Ads", desc: "Campaign performance and spend", tag: "Marketing", action: null },
  { name: "Meta Ads", desc: "Facebook + Instagram ad performance", tag: "Marketing", action: null },
];

export default function ConnectionsPage() {
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pgOpen, setPgOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConnectorRecord | null>(null);

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

  const seedDemo = async () => {
    setSeeding(true);
    setError(null);
    try {
      const res = await fetch("/api/connections/seed-demo", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.errorMessage
            ? `${data.error}\n${data.errorMessage}`
            : data.error ?? `HTTP ${res.status}`
        );
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSeeding(false);
    }
  };

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

  const hasDemoConnector = connectors.some((c) => c.type === "demo");

  return (
    <div className="container-page py-8">
      <header className="mb-8">
        <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">Connections</h1>
        <p className="mt-1 text-[14px] text-text-secondary">
          Wire up the systems that power your business. Liveli runs the ingestion, manages
          the warehouse, and keeps your data fresh.
        </p>
      </header>

      {!hasDemoConnector && (
        <section className="card-elevated mb-10 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
              <SparkleIcon className="text-accent" />
            </div>
            <div>
              <h2 className="text-[15px] font-medium text-text-primary">Try with sample data</h2>
              <p className="mt-1 text-[13px] text-text-secondary">
                Instantly load the TheLook E-commerce dataset so you can start chatting with the
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
                  Connect Postgres below, or click &ldquo;Load sample data&rdquo; above.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {connectors.map((c) => (
              <div key={c.id} className="card-elevated p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium text-text-primary">{c.name}</div>
                    <div className="mt-0.5 text-[12px] text-text-secondary">
                      {c.type === "demo" ? (
                        <>{c.tables?.length ?? 0} tables · {c.tables?.join(", ") ?? ""}</>
                      ) : (
                        <>type: {c.type}</>
                      )}
                    </div>
                    {c.lastError && (
                      <div className="mt-2 truncate text-[11px] text-[color:var(--status-error)]">
                        {c.lastError}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <StatusBadge status={c.status} />
                    <div className="flex items-center gap-1.5">
                      {c.type !== "demo" && (
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
                      )}
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
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {popularSources.map((s) => {
            const interactive = s.action === "postgres";
            return (
              <button
                key={s.name}
                type="button"
                onClick={() => {
                  if (s.action === "postgres") setPgOpen(true);
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
                    {s.tag}
                  </span>
                </div>
                <h3 className="mb-1 text-[15px] font-semibold text-text-primary font-heading">{s.name}</h3>
                <p className="text-[13px] leading-relaxed text-text-secondary">{s.desc}</p>
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
      </section>

      <PostgresWizard
        open={pgOpen}
        onClose={() => setPgOpen(false)}
        onConnected={() => {
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
                <li>Revoke and delete the stored credentials from Secret Manager.</li>
                <li>Stop any future syncs for this source.</li>
                <li>
                  <span className="font-medium text-text-primary">
                    Keep your already-synced tables
                  </span>{" "}
                  in BigQuery — they remain queryable by the agent. Drop the workspace
                  dataset manually if you want to wipe the data too.
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
