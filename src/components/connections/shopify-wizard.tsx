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

interface ShopifyWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  store: string;
  adminApiKey: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Shopify",
  store: "",
  adminApiKey: "",
  syncFrequency: "1h",
};

/**
 * Normalise whatever the customer pastes into the canonical
 * "<store>.myshopify.com" form the tap expects. Accepts plain handles,
 * full URLs (with or without scheme + trailing path) and bare hostnames.
 */
function normaliseStore(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  // Strip scheme + paths.
  const noScheme = trimmed.replace(/^https?:\/\//, "").split("/")[0];
  // If they pasted just the handle, append the suffix.
  if (!noScheme.includes(".")) return `${noScheme}.myshopify.com`;
  return noScheme;
}

export function ShopifyWizard({ open, onClose, onConnected }: ShopifyWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const store = normaliseStore(form.store);
    if (!/\.myshopify\.com$/.test(store)) {
      setError("Store handle should end in .myshopify.com — paste either the handle (e.g. acme) or the full URL.");
      return;
    }
    const token = form.adminApiKey.trim();
    if (!/^shpat_/.test(token)) {
      setError("That doesn't look like a Shopify Admin API access token — it should start with shpat_.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/shopify/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, store, adminApiKey: token }),
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
    <Modal open={open} onClose={onClose} title="Connect Shopify" maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Connection name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Main store"
            className={inputClass}
          />
        </Field>

        <Field
          label="Store handle"
          hint="Either the handle (acme) or the full URL (acme.myshopify.com)."
        >
          <input
            type="text"
            required
            value={form.store}
            onChange={(e) => update("store", e.target.value)}
            placeholder="acme.myshopify.com"
            className={inputClass}
          />
        </Field>

        <Field
          label="Admin API access token"
          hint="Create a custom app in your Shopify admin with read access to Orders, Products, Customers, Inventory and Locations. Starts with shpat_."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.adminApiKey}
            onChange={(e) => update("adminApiKey", e.target.value)}
            placeholder="shpat_…"
            className={inputClass}
          />
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
