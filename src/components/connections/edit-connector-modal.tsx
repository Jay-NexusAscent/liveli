"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
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
  onSaved: () => void;
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
export function EditConnectorModal({ connector, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

        {error && (
          <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-3 py-2 text-[12px] text-[color:var(--status-error)]">
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
