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

interface ZendeskWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  subdomain: string;
  email: string;
  apiToken: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Zendesk",
  subdomain: "",
  email: "",
  apiToken: "",
  syncFrequency: "1h",
};

/**
 * Normalise a customer-pasted Zendesk identifier to just the subdomain
 * slug. Accepts:
 *   - bare slug: "yourcompany"
 *   - full host: "yourcompany.zendesk.com"
 *   - full URL: "https://yourcompany.zendesk.com"
 * tap-zendesk wants the bare slug; we strip the suffix.
 */
function normaliseSubdomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0];
  s = s.replace(/\.zendesk\.com$/, "");
  return s;
}

export function ZendeskWizard({ open, onClose, onConnected }: ZendeskWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const subdomain = normaliseSubdomain(form.subdomain);
    const email = form.email.trim();
    const apiToken = form.apiToken.trim();

    if (!/^[a-z0-9][a-z0-9-]*$/.test(subdomain)) {
      setError(
        `Subdomain looks invalid. Use just the slug from yourcompany.zendesk.com (got "${subdomain}").`
      );
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(
        "Email looks invalid. Use the email of the Zendesk user who created the API token."
      );
      return;
    }
    if (!apiToken) {
      setError(
        "API token is required. Generate one in Zendesk Admin Center → Apps and integrations → Zendesk API → Token Access."
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/zendesk/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, subdomain, email, apiToken }),
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
    <Modal open={open} onClose={onClose} title="Connect Zendesk Support" maxWidth="max-w-lg">
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
          label="Subdomain"
          hint="The slug from your Zendesk URL — yourcompany from yourcompany.zendesk.com. Paste the full URL if easier; we'll extract."
        >
          <input
            type="text"
            required
            value={form.subdomain}
            onChange={(e) => update("subdomain", e.target.value)}
            placeholder="yourcompany"
            className={inputClass}
          />
        </Field>

        <Field
          label="Account email"
          hint="Email of the Zendesk user who created the API token."
        >
          <input
            type="email"
            required
            autoComplete="off"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            placeholder="you@yourcompany.com"
            className={inputClass}
          />
        </Field>

        <Field
          label="API token"
          hint="Zendesk Admin Center → Apps and integrations → Zendesk API → Token Access → Add API token."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.apiToken}
            onChange={(e) => update("apiToken", e.target.value)}
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
