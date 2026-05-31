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

interface ChargebeeWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  site: string;
  apiKey: string;
  productCatalog: "1.0" | "2.0";
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Chargebee",
  site: "",
  apiKey: "",
  productCatalog: "2.0",
  syncFrequency: "1h",
};

function normalizeSite(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\.chargebee\.com.*$/i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

export function ChargebeeWizard({ open, onClose, onConnected }: ChargebeeWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const site = normalizeSite(form.site);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(site)) {
      setError("Enter the site name from yoursite.chargebee.com (e.g. yoursite).");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/chargebee/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, site, apiKey: form.apiKey.trim() }),
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
    <Modal open={open} onClose={onClose} title="Connect Chargebee" maxWidth="max-w-lg">
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
          label="Site"
          hint="The site name from yoursite.chargebee.com. Pasting the full URL is fine — we'll trim it."
        >
          <input
            type="text"
            required
            value={form.site}
            onChange={(e) => update("site", e.target.value)}
            placeholder="yoursite"
            className={inputClass}
          />
        </Field>

        <Field
          label="API key"
          hint="Chargebee → Settings → Configure Chargebee → API Keys. A read-only key is enough."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => update("apiKey", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Product Catalog version"
          hint="Must match your Chargebee account's plan version. Most accounts are on 2.0."
        >
          <select
            value={form.productCatalog}
            onChange={(e) => update("productCatalog", e.target.value as "1.0" | "2.0")}
            className={inputClass}
          >
            <option value="2.0">2.0 (current default)</option>
            <option value="1.0">1.0 (legacy)</option>
          </select>
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
          <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-3 py-2 text-[12px] whitespace-pre-wrap text-[color:var(--status-error)]">
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
