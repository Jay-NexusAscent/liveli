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

interface SageIntacctWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  companyId: string;
  senderId: string;
  senderPassword: string;
  userId: string;
  userPassword: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Sage Intacct",
  companyId: "",
  senderId: "",
  senderPassword: "",
  userId: "",
  userPassword: "",
  syncFrequency: "1h",
};

export function SageIntacctWizard({ open, onClose, onConnected }: SageIntacctWizardProps) {
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
      const res = await fetch("/api/connections/sage-intacct/connect", {
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
    <Modal open={open} onClose={onClose} title="Connect Sage Intacct" maxWidth="max-w-lg">
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

        <Field label="Company ID" hint="Your Intacct company ID (the one you log in with).">
          <input
            type="text"
            required
            value={form.companyId}
            onChange={(e) => update("companyId", e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Sender ID" hint="Web Services sender ID issued by Sage.">
            <input
              type="text"
              required
              autoComplete="off"
              value={form.senderId}
              onChange={(e) => update("senderId", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Sender password">
            <input
              type="password"
              required
              autoComplete="off"
              value={form.senderPassword}
              onChange={(e) => update("senderPassword", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="User ID" hint="Your Web Services user login for this company.">
            <input
              type="text"
              required
              autoComplete="off"
              value={form.userId}
              onChange={(e) => update("userId", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="User password">
            <input
              type="password"
              required
              autoComplete="new-password"
              value={form.userPassword}
              onChange={(e) => update("userPassword", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

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
