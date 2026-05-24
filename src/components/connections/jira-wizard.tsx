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

interface JiraWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  domain: string;
  email: string;
  apiToken: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Jira",
  domain: "",
  email: "",
  apiToken: "",
  syncFrequency: "1h",
};

/**
 * Normalise a customer-pasted domain to the canonical
 * `<workspace>.atlassian.net` form. Accepts:
 *   - bare workspace name: "yourcompany"
 *   - workspace + suffix: "yourcompany.atlassian.net"
 *   - full URL: "https://yourcompany.atlassian.net"
 * Strips protocol, trailing slash, and any path. Adds ".atlassian.net"
 * suffix if missing.
 */
function normaliseDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.split("/")[0];
  d = d.replace(/\/$/, "");
  if (!d.includes(".")) d = `${d}.atlassian.net`;
  return d;
}

export function JiraWizard({ open, onClose, onConnected }: JiraWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const domain = normaliseDomain(form.domain);
    const email = form.email.trim();
    const apiToken = form.apiToken.trim();

    if (!/\.atlassian\.net$/.test(domain)) {
      setError(
        `Jira domain must be your Atlassian site (e.g. yourcompany.atlassian.net). Got "${domain}".`
      );
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Account email looks invalid. Use the email of the user who owns the API token.");
      return;
    }
    if (!apiToken) {
      setError(
        "API token is required. Create one at id.atlassian.com → Account → Security → API tokens."
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/jira/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, domain, email, apiToken }),
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
    <Modal open={open} onClose={onClose} title="Connect Jira" maxWidth="max-w-lg">
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
          label="Jira domain"
          hint="Your Atlassian site, e.g. yourcompany.atlassian.net. We auto-add .atlassian.net if you just paste the workspace name."
        >
          <input
            type="text"
            required
            value={form.domain}
            onChange={(e) => update("domain", e.target.value)}
            placeholder="yourcompany.atlassian.net"
            className={inputClass}
          />
        </Field>

        <Field
          label="Account email"
          hint="Email of the Atlassian user that owns the API token."
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
          hint="Create at id.atlassian.com → Account → Security → API tokens. The token is used together with the email as Basic auth."
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
