"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

interface PostgresWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  schemas: string;
}

const initialForm: FormState = {
  name: "Postgres",
  host: "",
  port: "5432",
  database: "",
  user: "",
  password: "",
  ssl: true,
  schemas: "public",
};

export function PostgresWizard({ open, onClose, onConnected }: PostgresWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  // Read the response body safely — handle empty bodies, non-JSON,
  // and structured server error envelopes uniformly.
  const readResponse = async (res: Response) => {
    const text = await res.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { errorMessage: text };
      }
    } else {
      data = { errorMessage: `Empty response body (HTTP ${res.status})` };
    }
    return data;
  };

  const formatError = (data: Record<string, unknown>, fallbackStatus: number): string => {
    const err = data.error as string | undefined;
    const msg = data.errorMessage as string | undefined;
    if (err && msg && err !== msg) return `${err}\n${msg}`;
    return err ?? msg ?? `HTTP ${fallbackStatus}`;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/postgres/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          port: Number(form.port),
        }),
      });
      const data = await readResponse(res);
      if (!res.ok) {
        throw new Error(formatError(data, res.status));
      }

      const connectorId = data.connectorId as string | undefined;
      if (autoSync && connectorId) {
        const syncRes = await fetch(`/api/connections/${connectorId}/sync`, {
          method: "POST",
        });
        const syncData = await readResponse(syncRes);
        if (!syncRes.ok) {
          setError(`Saved, but sync failed to start:\n${formatError(syncData, syncRes.status)}`);
          setSubmitting(false);
          onConnected();
          return;
        }
      }

      setForm(initialForm);
      onConnected();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect PostgreSQL" maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Connection name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Production app db"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Host">
            <input
              type="text"
              required
              value={form.host}
              onChange={(e) => update("host", e.target.value)}
              placeholder="db.example.com"
              className={inputClass}
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              required
              value={form.port}
              onChange={(e) => update("port", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field label="Database">
          <input
            type="text"
            required
            value={form.database}
            onChange={(e) => update("database", e.target.value)}
            placeholder="postgres"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="User">
            <input
              type="text"
              required
              autoComplete="off"
              value={form.user}
              onChange={(e) => update("user", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              required
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field label="Schemas (comma-separated)" hint="Defaults to `public`. Leave as-is for most setups.">
          <input
            type="text"
            value={form.schemas}
            onChange={(e) => update("schemas", e.target.value)}
            className={inputClass}
          />
        </Field>

        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          <input
            type="checkbox"
            checked={form.ssl}
            onChange={(e) => update("ssl", e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Use SSL (recommended for any DB not on localhost)
        </label>

        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => setAutoSync(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Start the first sync immediately after connecting
        </label>

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
            className="rounded-md border border-border px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={cn(
              "rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_20px_var(--accent-glow-strong)]",
              submitting && "opacity-60"
            )}
          >
            {submitting ? "Connecting…" : autoSync ? "Connect & sync" : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-elevated px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-medium text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}
