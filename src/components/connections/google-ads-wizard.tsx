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

interface GoogleAdsWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerIds: string;
  loginCustomerId: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Google Ads",
  developerToken: "",
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  customerIds: "",
  loginCustomerId: "",
  syncFrequency: "1h",
};

// Strip any spaces / dashes the user pastes into customer IDs, then
// verify each remaining token is a 10-digit number.
function normaliseCustomerIds(raw: string): { ids: string[]; bad: string[] } {
  const tokens = raw
    .split(",")
    .map((t) => t.replace(/[-\s]/g, "").trim())
    .filter(Boolean);
  const ids: string[] = [];
  const bad: string[] = [];
  for (const t of tokens) {
    if (/^\d{10}$/.test(t)) ids.push(t);
    else bad.push(t);
  }
  return { ids, bad };
}

export function GoogleAdsWizard({ open, onClose, onConnected }: GoogleAdsWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const { ids, bad } = normaliseCustomerIds(form.customerIds);
    if (ids.length === 0) {
      setError("Add at least one 10-digit Google Ads customer ID (no dashes).");
      return;
    }
    if (bad.length > 0) {
      setError(
        `These don't look like 10-digit customer IDs: ${bad.join(", ")}. Strip the dashes and try again.`
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/google-ads/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          customerIds: ids.join(","),
          loginCustomerId: form.loginCustomerId.replace(/[-\s]/g, "").trim(),
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
    <Modal open={open} onClose={onClose} title="Connect Google Ads" maxWidth="max-w-lg">
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
          label="Developer token"
          hint="From Google Ads → Tools → API Center. Approved tokens only."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.developerToken}
            onChange={(e) => update("developerToken", e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="OAuth client ID">
            <input
              type="text"
              required
              autoComplete="off"
              value={form.clientId}
              onChange={(e) => update("clientId", e.target.value)}
              placeholder="…apps.googleusercontent.com"
              className={inputClass}
            />
          </Field>
          <Field label="OAuth client secret">
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
          label="Refresh token"
          hint="Run the Google Ads OAuth Playground or your own helper script and paste the offline refresh token here."
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
          label="Customer IDs"
          hint="One or more 10-digit customer IDs, comma-separated. Strip the dashes — 123-456-7890 → 1234567890."
        >
          <input
            type="text"
            required
            value={form.customerIds}
            onChange={(e) => update("customerIds", e.target.value)}
            placeholder="1234567890, 9876543210"
            className={inputClass}
          />
        </Field>

        <Field
          label="Login customer ID (optional)"
          hint="Manager (MCC) account that sits above the customer IDs above. Leave blank for non-manager accounts."
        >
          <input
            type="text"
            value={form.loginCustomerId}
            onChange={(e) => update("loginCustomerId", e.target.value)}
            placeholder="0123456789"
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
