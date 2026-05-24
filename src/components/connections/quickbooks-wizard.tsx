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

interface QuickbooksWizardProps {
  open: boolean;
  onClose: () => void;
  /** Unused in the OAuth flow (see ga4-wizard for the same comment). */
  onConnected: () => void;
}

interface FormState {
  name: string;
  isSandbox: boolean;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "QuickBooks",
  isSandbox: false,
  syncFrequency: "1h",
};

/**
 * QuickBooks connector wizard. Same OAuth redirect pattern as the
 * GA4 wizard — collect non-secret toggles, fire /api/auth/oauth/intuit/start,
 * navigate the browser to Intuit's consent screen. The realmId
 * (QuickBooks Company ID) is captured by the server-side callback;
 * customer never types it in.
 */
export function QuickbooksWizard({ open, onClose }: QuickbooksWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/oauth/intuit/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorType: "quickbooks",
          name: form.name,
          syncFrequency: form.syncFrequency,
          autoSync,
          // is_sandbox is per-customer state but not a secret — bundle
          // into extras so it lands on the connector secret payload via
          // the callback (where buildTapEnv reads it as creds.is_sandbox).
          extras: { is_sandbox: form.isSandbox ? "true" : "false" },
        }),
      });
      const data = await readResponse(res);
      if (!res.ok) throw new Error(formatError(data, res.status));

      const url = data.redirectUrl as string | undefined;
      if (!url) throw new Error("OAuth start returned no redirect URL");
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect QuickBooks Online" maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Connection name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
            className={inputClass}
          />
        </Field>

        <Field
          label="QuickBooks environment"
          hint="Most customers connect Production. Use Sandbox only if you're testing against a QuickBooks sandbox company."
        >
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setForm((s) => ({ ...s, isSandbox: false }))}
              className={cn(
                "rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
                !form.isSandbox
                  ? "border-accent bg-accent-muted text-accent"
                  : "border-border bg-elevated text-text-secondary hover:bg-hover"
              )}
            >
              Production
            </button>
            <button
              type="button"
              onClick={() => setForm((s) => ({ ...s, isSandbox: true }))}
              className={cn(
                "rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
                form.isSandbox
                  ? "border-accent bg-accent-muted text-accent"
                  : "border-border bg-elevated text-text-secondary hover:bg-hover"
              )}
            >
              Sandbox
            </button>
          </div>
        </Field>

        <SyncFrequencyField
          value={form.syncFrequency}
          onChange={(v) => setForm((s) => ({ ...s, syncFrequency: v }))}
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

        <div className="rounded-md border border-border bg-elevated px-3 py-2 text-[12px] text-text-secondary">
          <p>
            Clicking Connect will redirect you to Intuit to grant Liveli read access
            to your QuickBooks company. We never see your Intuit password.
          </p>
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
            {submitting ? "Redirecting to Intuit…" : "Sign in with Intuit"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
