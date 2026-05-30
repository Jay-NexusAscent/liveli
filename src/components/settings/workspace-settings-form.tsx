"use client";

import { useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  SUPPORTED_AGENT_LOCALES,
  SUPPORTED_AGENT_PERSONAS,
  SUPPORTED_CURRENCIES,
  SUPPORTED_TIMEZONES,
  type WorkspaceSettings,
} from "@/lib/workspace-settings";

/**
 * Editable workspace settings — two SettingsSections ("Regional
 * preferences" and "Agent") owned by a single client-side state +
 * single Save action. Splitting state across two independent forms
 * would require two API round-trips for the common case ("change my
 * currency AND my agent tone") so we keep it consolidated and present
 * the section break visually.
 *
 * Save UX matches the rest of the settings page: inline status pill
 * next to the button (no toasts — the page doesn't carry a toast
 * provider). Status auto-clears after 2.4s of "saved" / "error" so the
 * surface settles back to neutral.
 */
type SaveState = "idle" | "saving" | "saved" | "error";

interface Props {
  initial: WorkspaceSettings;
}

export function WorkspaceSettingsForm({ initial }: Props) {
  const [s, setS] = useState<WorkspaceSettings>(initial);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Free-text IANA fallback. When the user picks a timezone from the
  // dropdown it sets `s.timezone` directly; "Other" reveals the input
  // pre-populated with the current value so they can type any IANA name.
  const isCustomTimezone = !SUPPORTED_TIMEZONES.includes(
    s.timezone as (typeof SUPPORTED_TIMEZONES)[number]
  );
  const [tzMode, setTzMode] = useState<"preset" | "custom">(
    isCustomTimezone ? "custom" : "preset"
  );

  const onSave = async () => {
    setSaveState("saving");
    setError(null);
    try {
      const res = await fetch("/api/workspaces/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { settings: WorkspaceSettings };
      setS(data.settings);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 2400);
    }
  };

  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  return (
    <>
      <SettingsSection title="Regional preferences">
        <div className="card-elevated p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Currency">
              <Select
                value={s.currency}
                onChange={(v) => setS({ ...s, currency: v })}
                options={SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }))}
                ariaLabel="Currency"
              />
            </FormField>

            <FormField label="Timezone">
              {tzMode === "preset" ? (
                <Select
                  value={s.timezone}
                  onChange={(v) => {
                    if (v === "__other__") {
                      setTzMode("custom");
                      return;
                    }
                    setS({ ...s, timezone: v });
                  }}
                  options={[
                    ...SUPPORTED_TIMEZONES.map((tz) => ({ value: tz, label: tz })),
                    { value: "__other__", label: "Other (IANA name)…" },
                  ]}
                  ariaLabel="Timezone"
                />
              ) : (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={s.timezone}
                    onChange={(e) => setS({ ...s, timezone: e.target.value })}
                    placeholder="e.g. America/Chicago"
                    className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                    aria-label="Timezone (IANA)"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setTzMode("preset");
                      setS({ ...s, timezone: "Europe/London" });
                    }}
                    className="rounded-md border border-border px-2.5 py-1 text-[12px] text-text-secondary hover:bg-hover hover:text-text-primary"
                  >
                    Presets
                  </button>
                </div>
              )}
            </FormField>

            <FormField label="Date format">
              <Select
                value={s.dateFormat}
                onChange={(v) =>
                  setS({ ...s, dateFormat: v as WorkspaceSettings["dateFormat"] })
                }
                options={[
                  { value: "dd/mm/yyyy", label: "dd/mm/yyyy" },
                  { value: "mm/dd/yyyy", label: "mm/dd/yyyy" },
                  { value: "yyyy-mm-dd", label: "yyyy-mm-dd" },
                ]}
                ariaLabel="Date format"
              />
            </FormField>

            <FormField label="Number format">
              <Select
                value={s.numberFormat}
                onChange={(v) =>
                  setS({
                    ...s,
                    numberFormat: v as WorkspaceSettings["numberFormat"],
                  })
                }
                options={[
                  { value: "1,234.56", label: "1,234.56" },
                  { value: "1.234,56", label: "1.234,56" },
                  { value: "1 234,56", label: "1 234,56" },
                ]}
                ariaLabel="Number format"
              />
            </FormField>

            <FormField label="Week starts on">
              <Select
                value={s.weekStart}
                onChange={(v) =>
                  setS({ ...s, weekStart: v as WorkspaceSettings["weekStart"] })
                }
                options={[
                  { value: "monday", label: "Monday" },
                  { value: "sunday", label: "Sunday" },
                ]}
                ariaLabel="Week start"
              />
            </FormField>

            <FormField label="Fiscal year starts">
              <Select
                value={String(s.fiscalYearStartMonth)}
                onChange={(v) =>
                  setS({ ...s, fiscalYearStartMonth: Number(v) })
                }
                options={MONTHS.map((m, i) => ({
                  value: String(i + 1),
                  label: m,
                }))}
                ariaLabel="Fiscal year start month"
              />
            </FormField>
          </div>
          <p className="mt-4 text-[11px] text-text-tertiary">
            Charts, tables, and the agent will use these defaults. Currency on
            connectors that report their own (e.g. Stripe) overrides this on
            a per-chart basis.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title="Agent">
        <div className="card-elevated p-6">
          <div className="mb-4 text-[12px] text-text-secondary">
            Affects how the agent talks to you. Independent of the data
            formatting above.
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Language">
              <Select
                value={s.agentLocale}
                onChange={(v) =>
                  setS({ ...s, agentLocale: v as WorkspaceSettings["agentLocale"] })
                }
                options={SUPPORTED_AGENT_LOCALES.map((l) => ({
                  value: l,
                  label: LOCALE_LABELS[l],
                }))}
                ariaLabel="Agent locale"
              />
            </FormField>
            <FormField label="Tone">
              <Select
                value={s.agentPersona}
                onChange={(v) =>
                  setS({
                    ...s,
                    agentPersona: v as WorkspaceSettings["agentPersona"],
                  })
                }
                options={SUPPORTED_AGENT_PERSONAS.map((p) => ({
                  value: p,
                  label: PERSONA_LABELS[p],
                }))}
                ariaLabel="Agent tone"
              />
            </FormField>
          </div>
          <p className="mt-4 text-[11px] text-text-tertiary">
            Built-in safety rules (no swearing, no legal/financial/medical
            advice, no PII echo, refuse harmful requests) always apply and
            cannot be overridden.
          </p>

          <div className="mt-6 flex items-center gap-3">
            <ActionButton
              variant="primary"
              size="md"
              onClick={onSave}
              disabled={!dirty || saveState === "saving"}
            >
              {saveState === "saving" ? "Saving…" : "Save changes"}
            </ActionButton>
            {saveState === "saved" && (
              <span className="text-[12px] text-[color:var(--status-success)]">
                Saved
              </span>
            )}
            {saveState === "error" && (
              <span className="text-[12px] text-[color:var(--status-error)]">
                {error ?? "Failed to save"}
              </span>
            )}
          </div>
        </div>
      </SettingsSection>
    </>
  );
}

/**
 * Lightweight labeled form row — keeps the field label / control gap
 * consistent across the regional + agent cards without dragging in a
 * full Form component for the sake of two cards.
 */
function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary focus:border-accent focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const LOCALE_LABELS: Record<WorkspaceSettings["agentLocale"], string> = {
  "en-GB": "English (UK)",
  "en-US": "English (US)",
  "en-AU": "English (Australia)",
  "en-CA": "English (Canada)",
  "en-IN": "English (India)",
};

const PERSONA_LABELS: Record<WorkspaceSettings["agentPersona"], string> = {
  professional: "Professional",
  friendly: "Friendly",
  direct: "Direct",
  casual: "Casual",
};
