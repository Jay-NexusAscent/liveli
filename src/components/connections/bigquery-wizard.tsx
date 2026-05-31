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

interface BigqueryWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  projectId: string;
  credentialsJson: string;
  datasets: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "BigQuery",
  projectId: "",
  credentialsJson: "",
  datasets: "",
  syncFrequency: "1h",
};

export function BigqueryWizard({ open, onClose, onConnected }: BigqueryWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  // If the user pastes the SA key JSON, auto-fill the Project ID from
  // its `project_id` field so they don't have to type it twice.
  const handleCredsChange = (raw: string) => {
    update("credentialsJson", raw);
    try {
      const parsed = JSON.parse(raw);
      if (parsed.project_id && !form.projectId) {
        update("projectId", String(parsed.project_id));
      }
    } catch {
      // partial paste / not yet valid JSON — ignore
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/bigquery/connect", {
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
    <Modal open={open} onClose={onClose} title="Connect BigQuery" maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Connection name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Production analytics"
            className={inputClass}
          />
        </Field>

        <Field
          label="Service account key (JSON)"
          hint="Create a service account in your Google Cloud project with the BigQuery Data Viewer + BigQuery Job User roles, download a JSON key, and paste the full file contents here."
        >
          <textarea
            required
            rows={6}
            value={form.credentialsJson}
            onChange={(e) => handleCredsChange(e.target.value)}
            placeholder='{ "type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…" }'
            className={cn(inputClass, "font-mono text-[11px] leading-relaxed")}
          />
        </Field>

        <Field
          label="Project ID"
          hint="Auto-filled from the key above; override if you want to read a different project the key can access."
        >
          <input
            type="text"
            required
            value={form.projectId}
            onChange={(e) => update("projectId", e.target.value)}
            placeholder="my-gcp-project"
            className={inputClass}
          />
        </Field>

        <SyncFrequencyField
          value={form.syncFrequency}
          onChange={(v) => update("syncFrequency", v)}
        />

        <Field
          label="Datasets (comma-separated, optional)"
          hint="Defaults to all datasets the service account can read. Scope to specific datasets to keep the first sync fast."
        >
          <input
            type="text"
            value={form.datasets}
            onChange={(e) => update("datasets", e.target.value)}
            placeholder="e.g. analytics, marketing"
            className={inputClass}
          />
        </Field>

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
