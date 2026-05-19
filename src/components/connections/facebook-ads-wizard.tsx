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

interface FacebookAdsWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  accessToken: string;
  accountId: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Meta Ads",
  accessToken: "",
  accountId: "",
  syncFrequency: "1h",
};

// Customers paste account IDs in many forms — bare numbers, with the
// "act_" prefix, or copied from the URL. Normalise to "act_<digits>".
function normaliseAccountId(raw: string): string {
  const trimmed = raw.trim().replace(/^act_/i, "");
  if (!/^\d+$/.test(trimmed)) return raw.trim();
  return `act_${trimmed}`;
}

export function FacebookAdsWizard({ open, onClose, onConnected }: FacebookAdsWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const accountId = normaliseAccountId(form.accountId);
    if (!/^act_\d+$/.test(accountId)) {
      setError("Account ID should be a number (act_xxxxxx). Copy it from Meta Ads Manager.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/facebook-ads/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, accountId, accessToken: form.accessToken.trim() }),
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
    <Modal open={open} onClose={onClose} title="Connect Meta Ads" maxWidth="max-w-lg">
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
          label="Long-lived access token"
          hint="Generate via Meta Business Suite → Settings → System Users. Token must have ads_read on the target ad account."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.accessToken}
            onChange={(e) => update("accessToken", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Ad account ID"
          hint="Found in Meta Ads Manager URL or under Account Overview. Either format works — we'll add the act_ prefix for you."
        >
          <input
            type="text"
            required
            value={form.accountId}
            onChange={(e) => update("accountId", e.target.value)}
            placeholder="act_1234567890"
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
