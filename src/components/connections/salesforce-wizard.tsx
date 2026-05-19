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

interface SalesforceWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  domain: "login" | "test";
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Salesforce",
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  domain: "login",
  syncFrequency: "1h",
};

export function SalesforceWizard({ open, onClose, onConnected }: SalesforceWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/salesforce/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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
    <Modal open={open} onClose={onClose} title="Connect Salesforce" maxWidth="max-w-lg">
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

        <div className="grid grid-cols-2 gap-3">
          <Field label="Connected App client ID">
            <input
              type="text"
              required
              autoComplete="off"
              value={form.clientId}
              onChange={(e) => update("clientId", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Connected App client secret">
            <input
              type="password"
              required
              autoComplete="off"
              value={form.clientSecret}
              onChange={(e) => update("clientSecret", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field
          label="OAuth refresh token"
          hint="Run a one-time OAuth flow against your Connected App to obtain an offline refresh token, then paste it here."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.refreshToken}
            onChange={(e) => update("refreshToken", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Org type"
          hint="Production / Developer orgs use login.salesforce.com; sandboxes use test.salesforce.com."
        >
          <div className="flex gap-2">
            {(["login", "test"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => update("domain", d)}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
                  form.domain === d
                    ? "border-accent bg-accent-muted text-accent"
                    : "border-border bg-elevated text-text-secondary hover:bg-hover"
                )}
              >
                {d === "login" ? "Production / Developer" : "Sandbox"}
              </button>
            ))}
          </div>
        </Field>

        <SyncFrequencyField
          value={form.syncFrequency}
          onChange={(v) => update("syncFrequency", v)}
        />

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
