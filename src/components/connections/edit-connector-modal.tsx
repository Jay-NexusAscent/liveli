"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { cn } from "@/lib/utils";

type SyncFrequency = "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";

const SYNC_FREQUENCIES: Array<{ value: SyncFrequency; label: string }> = [
  { value: "5m", label: "Every 5 minutes" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "30m", label: "Every 30 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "24h", label: "Once a day" },
];

interface ConnectorForEdit {
  id: string;
  name: string;
  type: string;
  syncFrequency?: SyncFrequency;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  schemas?: string;
}

interface Props {
  connector: ConnectorForEdit | null;
  onClose: () => void;
  /** Fired after the regular save (name/schedule/credentials patch). */
  onSaved: () => void;
  /** Fired after Danger Zone → Delete connector succeeds. Caller is
   * expected to close this modal and refresh the connector list. */
  onDeleted: () => void;
}

interface FormState {
  name: string;
  syncFrequency: SyncFrequency;
  schemas: string;
  // Credentials — left empty unless the user expands the section to update.
  showCreds: boolean;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/**
 * Edit an existing connector. Two scope levels:
 *   - Always-editable: friendly name, sync frequency, schemas.
 *   - Optional credential reset: user explicitly opens the "Update
 *     credentials" section. Empty creds == leave existing secret in
 *     place. Full creds set == write new Secret Manager version.
 */
export function EditConnectorModal({ connector, onClose, onSaved, onDeleted }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which destructive action the user has clicked but not yet confirmed.
   * Null when the danger-zone confirm modal is closed. */
  const [pendingDanger, setPendingDanger] = useState<"refresh" | "delete" | null>(null);

  useEffect(() => {
    if (!connector) return;
    setForm({
      name: connector.name ?? "",
      syncFrequency: connector.syncFrequency ?? "1h",
      schemas: connector.schemas ?? "public",
      showCreds: false,
      host: connector.host ?? "",
      port: String(connector.port ?? 5432),
      database: connector.database ?? "",
      user: connector.user ?? "",
      password: "",
      ssl: connector.ssl ?? true,
    });
    setError(null);
  }, [connector]);

  if (!connector) return null;

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  /** Same auto-parse helper as PostgresWizard — pasting a full URL
   *  splits into the other fields. */
  const handleHostChange = (raw: string) => {
    const trimmed = raw.trim();
    if (/^postgres(ql)?:\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed);
        setForm((s) => ({
          ...s,
          host: url.hostname,
          port: url.port || "5432",
          database: url.pathname.replace(/^\//, "") || s.database,
          user: decodeURIComponent(url.username) || s.user,
          password: decodeURIComponent(url.password) || s.password,
          ssl: url.searchParams.get("sslmode")
            ? url.searchParams.get("sslmode") !== "disable"
            : s.ssl,
        }));
        return;
      } catch {
        /* fall through */
      }
    }
    if (trimmed.includes("@")) {
      const afterAt = trimmed.split("@").pop() ?? trimmed;
      update("host", afterAt);
      setError(
        "Looks like you pasted a connection string — auto-extracted the hostname."
      );
      return;
    }
    update("host", trimmed);
  };

  /**
   * Confirm handler for the Danger Zone actions. The action verb is
   * captured in `pendingDanger` — this single function routes to the
   * right endpoint and unifies the success path (close the modal +
   * fire the appropriate callback).
   */
  const runDangerAction = async () => {
    if (!connector || !pendingDanger) return;
    setError(null);
    try {
      if (pendingDanger === "refresh") {
        const res = await fetch(
          `/api/connections/${connector.id}/full-refresh`,
          { method: "POST" }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            data.errorMessage
              ? `${data.error ?? "Fresh ingest failed"}\n${data.errorMessage}`
              : data.error ?? `HTTP ${res.status}`
          );
        }
        // Refresh starts a sync; let the parent know so its connector
        // list reflects status=syncing immediately.
        onSaved();
        onClose();
      } else {
        const res = await fetch(`/api/connections/${connector.id}`, {
          method: "DELETE",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            data.errorMessage
              ? `${data.error ?? "Delete failed"}\n${data.errorMessage}`
              : data.error ?? `HTTP ${res.status}`
          );
        }
        onDeleted();
      }
      setPendingDanger(null);
    } catch (err) {
      // Keep the danger-confirm modal open so the user sees the error
      // in context. ConfirmModal's `running` state will reset because
      // we let the promise reject.
      setError(err instanceof Error ? err.message : String(err));
      setPendingDanger(null);
      throw err;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      name: form.name,
      syncFrequency: form.syncFrequency,
      schemas: form.schemas,
    };

    if (form.showCreds) {
      // Require all credential fields if the user opened the section.
      if (
        !form.host ||
        !form.user ||
        !form.password ||
        !form.database ||
        !form.port
      ) {
        setError("All credential fields must be filled to update credentials.");
        setSubmitting(false);
        return;
      }
      payload.credentials = {
        host: form.host,
        port: Number(form.port),
        database: form.database,
        user: form.user,
        password: form.password,
        ssl: form.ssl,
      };
    }

    try {
      const res = await fetch(
        `/api/connections/${connector.id}/update`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <Modal
      open={!!connector}
      onClose={submitting ? () => {} : onClose}
      title={`Edit ${connector.name}`}
      maxWidth="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Connection name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Sync frequency"
          hint="How often Liveli will refresh data from this source."
        >
          <select
            value={form.syncFrequency}
            onChange={(e) =>
              update("syncFrequency", e.target.value as SyncFrequency)
            }
            className={inputClass}
          >
            {SYNC_FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>

        {connector.type === "postgres" && (
          <Field label="Schemas (comma-separated)" hint="Default: public.">
            <input
              type="text"
              value={form.schemas}
              onChange={(e) => update("schemas", e.target.value)}
              className={inputClass}
            />
          </Field>
        )}

        {/* Credentials section — collapsed by default. */}
        <div className="rounded-md border border-border-subtle bg-elevated p-4">
          {!form.showCreds ? (
            <button
              type="button"
              onClick={() => update("showCreds", true)}
              className="text-[13px] font-medium text-accent hover:text-accent-hover"
            >
              Update credentials →
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium text-text-primary">
                  New credentials
                </div>
                <button
                  type="button"
                  onClick={() => update("showCreds", false)}
                  className="text-[11px] text-text-tertiary hover:text-text-secondary"
                >
                  Cancel
                </button>
              </div>

              <div className="grid grid-cols-[1fr_100px] gap-3">
                <Field
                  label="Host"
                  hint="Paste a full postgresql:// URL to auto-fill the rest."
                >
                  <input
                    type="text"
                    value={form.host}
                    onChange={(e) => handleHostChange(e.target.value)}
                    placeholder="db.example.com"
                    className={inputClass}
                  />
                </Field>
                <Field label="Port">
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => update("port", e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>

              <Field label="Database">
                <input
                  type="text"
                  value={form.database}
                  onChange={(e) => update("database", e.target.value)}
                  className={inputClass}
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="User">
                  <input
                    type="text"
                    autoComplete="off"
                    value={form.user}
                    onChange={(e) => update("user", e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Password">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>

              <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={form.ssl}
                  onChange={(e) => update("ssl", e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                Use SSL
              </label>
            </div>
          )}
        </div>

        {/* ─── Danger zone ─────────────────────────────────────
            Destructive actions live here, separated from the
            save flow. Both use the shared ConfirmModal so they
            require an extra deliberate click. */}
        <div className="rounded-md border border-[color:var(--status-error)]/25 bg-[color:var(--status-error)]/5 p-4">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-[color:var(--status-error)]">
            Danger zone
          </div>

          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-text-primary">Fresh ingest</div>
                <p className="mt-0.5 text-[12px] text-text-secondary">
                  Drops the replicated data and re-syncs from your source. Use
                  after schema changes (renamed tables / dropped columns) or to
                  recover from a corrupted state. Charts and dashboards that
                  reference this connector will break until the resync completes.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPendingDanger("refresh")}
                disabled={submitting}
                className="shrink-0 rounded-md border border-border bg-elevated px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-[color:var(--status-error)]/40 hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)] disabled:opacity-60"
              >
                Wipe and re-ingest
              </button>
            </div>

            <div className="flex items-start justify-between gap-3 border-t border-[color:var(--status-error)]/15 pt-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-text-primary">Delete connector</div>
                <p className="mt-0.5 text-[12px] text-text-secondary">
                  Permanently removes this connector, its credentials, and all
                  replicated data. This cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPendingDanger("delete")}
                disabled={submitting}
                className="shrink-0 rounded-md border border-border bg-elevated px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-[color:var(--status-error)]/40 hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)] disabled:opacity-60"
              >
                Delete connector
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-3 py-2 text-[12px] whitespace-pre-wrap text-[color:var(--status-error)]">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-border px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={cn(
              "rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-text-inverted transition-all hover:bg-accent-hover",
              submitting && "opacity-60"
            )}
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>

    {/* Confirm-on-top modal for both Danger Zone actions. The
        ConfirmModal sits above the Edit modal in the stacking
        context — Modal renders to a portal so this works
        without any extra z-index gymnastics. */}
    <ConfirmModal
      open={pendingDanger === "refresh"}
      title="Wipe and re-ingest?"
      destructive
      confirmLabel="Wipe and re-ingest"
      cancelLabel="Cancel"
      message={
        <>
          <p>
            You&apos;re about to drop all replicated data for{" "}
            <span className="font-medium text-text-primary">{connector.name}</span>{" "}
            and resync from scratch.
          </p>
          <ul className="mt-3 ml-5 list-disc space-y-1 text-[13px]">
            <li>
              The current credentials and source schema will be re-read; any
              new tables / columns in your source will be picked up.
            </li>
            <li>
              <span className="font-medium text-text-primary">
                Charts and dashboards using this connector will fail
              </span>{" "}
              until the new sync completes.
            </li>
          </ul>
          <p className="mt-3 text-[12px] text-text-tertiary">
            Use this after source-schema changes or to recover from a corrupted state.
          </p>
        </>
      }
      onConfirm={runDangerAction}
      onCancel={() => setPendingDanger(null)}
    />

    <ConfirmModal
      open={pendingDanger === "delete"}
      title="Delete connector?"
      destructive
      confirmLabel="Delete connector"
      cancelLabel="Cancel"
      message={
        <>
          <p>
            You&apos;re about to delete{" "}
            <span className="font-medium text-text-primary">{connector.name}</span>
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
      }
      onConfirm={runDangerAction}
      onCancel={() => setPendingDanger(null)}
    />
    </>
  );
}

function emptyForm(): FormState {
  return {
    name: "",
    syncFrequency: "1h",
    schemas: "public",
    showCreds: false,
    host: "",
    port: "5432",
    database: "",
    user: "",
    password: "",
    ssl: true,
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-elevated px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";
