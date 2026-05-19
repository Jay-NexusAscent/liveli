"use client";

// Pieces shared across every connector wizard. The per-source wizards
// stay separate because their forms differ structurally (DB credentials
// vs single API key vs OAuth bundle), but the surrounding chrome —
// labels, inputs, sync-frequency dropdown, response parsing — is identical.

export type SyncFrequency = "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";

export const SYNC_FREQUENCIES: Array<{ value: SyncFrequency; label: string }> = [
  { value: "5m", label: "Every 5 minutes" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "30m", label: "Every 30 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "24h", label: "Once a day" },
];

export const inputClass =
  "w-full rounded-md border border-border bg-elevated px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-medium text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

export function SyncFrequencyField({
  value,
  onChange,
}: {
  value: SyncFrequency;
  onChange: (v: SyncFrequency) => void;
}) {
  return (
    <Field
      label="Sync frequency"
      hint="How often Liveli will pull fresh data from this source. Defaults to hourly."
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SyncFrequency)}
        className={inputClass}
      >
        {SYNC_FREQUENCIES.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Parse a fetch response uniformly — handles empty bodies, non-JSON, and
 * the structured server error envelopes returned by /api/connections/*.
 * Always returns an object so callers don't have to null-check.
 */
export async function readResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return { errorMessage: `Empty response body (HTTP ${res.status})` };
  try {
    return JSON.parse(text);
  } catch {
    return { errorMessage: text };
  }
}

/**
 * Compress the {error, errorMessage} server-side envelope down to a
 * single string for display. Includes both lines when they differ —
 * the server uses `error` for "what failed" and `errorMessage` for the
 * underlying technical reason.
 */
export function formatError(data: Record<string, unknown>, fallbackStatus: number): string {
  const err = data.error as string | undefined;
  const msg = data.errorMessage as string | undefined;
  if (err && msg && err !== msg) return `${err}\n${msg}`;
  return err ?? msg ?? `HTTP ${fallbackStatus}`;
}
