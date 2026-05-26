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

interface Ga4WizardProps {
  open: boolean;
  onClose: () => void;
  /** Unused in the OAuth flow — Liveli redirects to /connections via
   * the callback route. Kept on the prop interface for symmetry with
   * Batch A/B wizards (the parent doesn't need to special-case). */
  onConnected: () => void;
}

interface FormState {
  name: string;
  propertyId: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "Google Analytics 4",
  propertyId: "",
  syncFrequency: "1h",
};

// GA4 property IDs are numeric strings, typically 9 digits.
// `properties/123456789` is the GA4 resource name format; the tap wants
// just the bare numeric part — strip the prefix if pasted.
function normalisePropertyId(input: string): string {
  return input.trim().replace(/^properties\//, "").replace(/\D/g, "");
}

/**
 * GA4 connector wizard. Diverges from Batch A/B's pattern: instead of
 * collecting credentials in form fields, this collects only the
 * non-secret identifiers and triggers a real OAuth redirect to
 * Google's consent screen. On return the server-side callback
 * provisions the connector and redirects back to /connections.
 */
export function Ga4Wizard({ open, onClose }: Ga4WizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const propertyId = normalisePropertyId(form.propertyId);
    if (!/^\d{6,12}$/.test(propertyId)) {
      setError(
        `Property ID must be the numeric GA4 ID (e.g. 123456789). Got "${propertyId}". ` +
          `Find it in GA4 → Admin → Property settings → Property → Property details.`
      );
      return;
    }

    setSubmitting(true);
    try {
      // The OAuth start route signs a state blob with the form state,
      // builds Google's auth URL, and returns it for us to navigate to.
      // On return, the callback route handles connector provisioning
      // and redirects back to /connections.
      const res = await fetch("/api/auth/oauth/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorType: "ga4",
          name: form.name,
          syncFrequency: form.syncFrequency,
          autoSync,
          extras: { property_id: propertyId },
        }),
      });
      const data = await readResponse(res);
      if (!res.ok) throw new Error(formatError(data, res.status));

      const url = data.redirectUrl as string | undefined;
      if (!url) throw new Error("OAuth start returned no redirect URL");
      // Top-level navigation — Clerk's SameSite=Lax cookie travels
      // through Google's redirect back to our callback.
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect Google Analytics 4" maxWidth="max-w-lg">
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
          label="GA4 Property ID"
          hint="From GA4 → Admin → Property settings → Property → Property details. Numeric, 9 digits."
        >
          <input
            type="text"
            required
            inputMode="numeric"
            value={form.propertyId}
            onChange={(e) => update("propertyId", e.target.value)}
            placeholder="123456789"
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

        <div className="rounded-md border border-border bg-elevated px-3 py-2 text-[12px] text-text-secondary">
          <p>
            Clicking Connect will redirect you to Google to grant Liveli read access
            to your Analytics property. We never see your Google password.
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
            {submitting ? "Redirecting to Google…" : "Connect with Google"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
