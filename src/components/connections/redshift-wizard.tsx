"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  Field,
  SyncFrequencyField,
  formatError,
  inputClass,
  readResponse,
  type SyncFrequency,
} from "@/components/connections/wizard-shared";

interface RedshiftWizardProps {
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
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Amazon Redshift",
  host: "",
  port: "5439",
  database: "",
  user: "",
  password: "",
  ssl: true,
  schemas: "",
  syncFrequency: "1h",
};

export function RedshiftWizard({ open, onClose, onConnected }: RedshiftWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  // Redshift speaks the Postgres wire protocol, so a pasted
  // postgres://-style endpoint URL splits cleanly into the fields.
  const handleHostChange = (raw: string) => {
    const trimmed = raw.trim();
    if (/^(redshift|postgres(ql)?):\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed);
        setForm((s) => ({
          ...s,
          host: url.hostname,
          port: url.port || "5439",
          database: url.pathname.replace(/^\//, "") || s.database,
          user: decodeURIComponent(url.username) || s.user,
          password: decodeURIComponent(url.password) || s.password,
        }));
        return;
      } catch {
        // fall through
      }
    }
    if (trimmed.includes("@")) {
      const afterAt = trimmed.split("@").pop() ?? trimmed;
      update("host", afterAt);
      setError(
        "Looks like you pasted a connection string — auto-extracted the hostname. Double-check the other fields."
      );
      return;
    }
    update("host", trimmed);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/redshift/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          port: Number(form.port),
        }),
      });
      const data = await readResponse(res);
      if (!res.ok) throw new Error(formatError(data, res.status));

      const connectorId = data.connectorId as string | undefined;
      if (autoSync && connectorId) {
        const syncRes = await fetch(`/api/connections/${connectorId}/sync`, { method: "POST" });
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
    <Modal open={open} onClose={onClose} title="Connect Amazon Redshift" maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Connection name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Analytics warehouse"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field
            label="Endpoint"
            hint="Your cluster endpoint, e.g. my-cluster.abc123.eu-west-1.redshift.amazonaws.com"
          >
            <input
              type="text"
              required
              value={form.host}
              onChange={(e) => handleHostChange(e.target.value)}
              placeholder="cluster.xxxx.region.redshift.amazonaws.com"
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
            placeholder="dev"
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

        <SyncFrequencyField
          value={form.syncFrequency}
          onChange={(v) => update("syncFrequency", v)}
        />

        <Field
          label="Schemas (comma-separated, optional)"
          hint="Defaults to public. Add others if your tables live in additional schemas."
        >
          <input
            type="text"
            value={form.schemas}
            onChange={(e) => update("schemas", e.target.value)}
            placeholder="e.g. public, analytics"
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
          Use SSL (required by most Redshift clusters)
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
