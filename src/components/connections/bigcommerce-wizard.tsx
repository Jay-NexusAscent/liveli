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

interface BigcommerceWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  storeHash: string;
  clientId: string;
  accessToken: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "BigCommerce",
  storeHash: "",
  clientId: "",
  accessToken: "",
  syncFrequency: "1h",
};

// Accept the bare hash or a full store-<hash>.mybigcommerce.com host.
function normalizeStoreHash(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "");
  const m = trimmed.match(/store-([a-z0-9]+)\.mybigcommerce\.com/i);
  if (m) return m[1].toLowerCase();
  return trimmed.replace(/\/.*$/, "").toLowerCase();
}

export function BigcommerceWizard({ open, onClose, onConnected }: BigcommerceWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const storeHash = normalizeStoreHash(form.storeHash);
    if (!/^[a-z0-9]+$/.test(storeHash)) {
      setError("Store hash is the id from store-<hash>.mybigcommerce.com (e.g. abc123).");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/bigcommerce/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          storeHash,
          clientId: form.clientId.trim(),
          accessToken: form.accessToken.trim(),
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
    <Modal open={open} onClose={onClose} title="Connect BigCommerce" maxWidth="max-w-lg">
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
          label="Store hash"
          hint="The id from store-<hash>.mybigcommerce.com. Pasting the full URL is fine."
        >
          <input
            type="text"
            required
            value={form.storeHash}
            onChange={(e) => update("storeHash", e.target.value)}
            placeholder="abc123"
            className={inputClass}
          />
        </Field>

        <Field
          label="Client ID"
          hint="BigCommerce → Settings → API Accounts → Create API account. Read-only scopes are enough."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.clientId}
            onChange={(e) => update("clientId", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Access token">
          <input
            type="password"
            required
            autoComplete="off"
            value={form.accessToken}
            onChange={(e) => update("accessToken", e.target.value)}
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
