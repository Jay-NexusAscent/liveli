/**
 * Workspace-level user preferences. Stored under WorkspaceDoc.settings.
 *
 * Two buckets:
 *
 *   1. **Regional** — affects how the agent talks about numbers/dates
 *      AND how charts/dashboards/tables render them. Currency is the
 *      most visible: an EU/GB customer expects "£1,234.56" not
 *      "$1,234.56", and date axes should match their locale.
 *   2. **Agent** — locale + persona inserted into the system-prompt
 *      preamble so the model speaks in the customer's English variant
 *      and tonal register.
 *
 * Safety rules are NOT here — those live in `agent.ts` as a hardcoded
 * constant and are appended AFTER user preamble so a hostile or
 * inattentive locale/persona setting can't override them.
 */
export interface WorkspaceSettings {
  // ── Regional ─────────────────────────────────────────────────────
  /**
   * ISO 4217 currency code (e.g. "GBP", "USD", "EUR"). Default "GBP".
   * Used by chart renderers' KPI currency formatting + injected into the
   * agent preamble so the model picks the right symbol.
   *
   * Connector-level currency metadata (e.g. Stripe's reported currency)
   * can override this per-chart at render time when the chart-spec carries
   * an explicit currency; the workspace setting is the FALLBACK default.
   */
  currency: string;
  /**
   * ISO 3166-1 alpha-2 country code (e.g. "GB", "US"). Describes the
   * customer's market — used to pick the BigQuery ML holiday calendar
   * when forecasting (a UK retailer dips on UK bank holidays, not US
   * ones). OPTIONAL with no default: when unset, forecasting simply
   * skips holiday modelling rather than imposing a wrong calendar. Only
   * codes BQML accepts (see SUPPORTED_COUNTRIES) enable holiday modelling.
   */
  country?: string;
  /** IANA timezone string. Default "Europe/London". */
  timezone: string;
  /** Date-format token used by table/axis renderers. */
  dateFormat: "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd";
  /** Number-format token. */
  numberFormat: "1,234.56" | "1.234,56" | "1 234,56";
  weekStart: "monday" | "sunday";
  /** 1-12. UK accounting default = April. */
  fiscalYearStartMonth: number;

  // ── Agent ────────────────────────────────────────────────────────
  /** Affects spelling + idioms in agent prose. */
  agentLocale: "en-GB" | "en-US" | "en-AU" | "en-CA" | "en-IN";
  /** Tonal register only; does NOT affect verbosity or content depth. */
  agentPersona: "professional" | "friendly" | "direct" | "casual";
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  currency: "GBP",
  timezone: "Europe/London",
  dateFormat: "dd/mm/yyyy",
  numberFormat: "1,234.56",
  weekStart: "monday",
  fiscalYearStartMonth: 4,
  agentLocale: "en-GB",
  agentPersona: "professional",
};

/** Curated currency dropdown — common ones, not all 200 ISO 4217 codes. */
export const SUPPORTED_CURRENCIES = [
  "GBP",
  "USD",
  "EUR",
  "JPY",
  "AUD",
  "CAD",
  "CHF",
  "INR",
  "CNY",
  "ZAR",
] as const;

/**
 * Curated timezone dropdown. The settings UI also allows free text for
 * any other IANA name — see `isValidIanaTimezone`.
 */
export const SUPPORTED_TIMEZONES = [
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
] as const;

/**
 * Country codes we've confirmed BigQuery ML accepts as a `holiday_region`.
 * The forecasting model only enables holiday modelling for a code in this
 * set — an unsupported code makes CREATE MODEL fail, so we omit (no holiday
 * modelling) when unsure rather than risk a training error. Expand only
 * after verifying additions against the BQML holiday_region docs.
 *
 * Doubles as the curated country dropdown for the settings UI.
 */
export const SUPPORTED_COUNTRIES = [
  "GB", "US", "CA", "AU", "IN", "DE", "FR", "BR", "JP", "IT",
  "ES", "NL", "MX", "ID", "IE", "NZ", "ZA", "SE", "NO", "PL",
] as const;

/**
 * Map a stored country code to a BigQuery ML `holiday_region` value, or
 * undefined when the code is unset / unsupported (→ no holiday modelling).
 */
export function holidayRegionForCountry(country?: string): string | undefined {
  if (!country) return undefined;
  const c = country.toUpperCase();
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(c) ? c : undefined;
}

export const SUPPORTED_AGENT_LOCALES: WorkspaceSettings["agentLocale"][] = [
  "en-GB",
  "en-US",
  "en-AU",
  "en-CA",
  "en-IN",
];

export const SUPPORTED_AGENT_PERSONAS: WorkspaceSettings["agentPersona"][] = [
  "professional",
  "friendly",
  "direct",
  "casual",
];

/**
 * Lenient IANA timezone validator — uses the runtime Intl API to ask
 * "does the JS runtime recognise this string?". Catches typos without
 * needing a bundled list of all 400+ IANA zones. Falls back to a
 * permissive shape check on engines that throw for unknown zones via
 * a different path.
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  // Reject obvious junk before hitting Intl — keeps validation cheap.
  if (!/^[A-Za-z_]+(?:\/[A-Za-z_]+)+$/.test(tz) && !/^(UTC|GMT)$/i.test(tz)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a partial settings object incoming from the API. Returns
 * `{ ok: true, value }` on success; `{ ok: false, error }` on failure.
 *
 * Why a hand-rolled validator instead of Zod: keeps the validation
 * close to the type definition above, and the shape is small enough
 * that the extra Zod dependency-in-the-validator buys little. The
 * route handler already uses Zod for the request envelope; this
 * focuses on per-field semantics (e.g. month 1-12, timezone IANA).
 */
export function validateSettingsPatch(
  raw: unknown
): { ok: true; value: Partial<WorkspaceSettings> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Body must be an object" };
  }
  const out: Partial<WorkspaceSettings> = {};
  const r = raw as Record<string, unknown>;

  if (r.currency !== undefined) {
    if (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency)) {
      return { ok: false, error: "currency must be a 3-letter ISO 4217 code" };
    }
    out.currency = r.currency;
  }
  if (r.country !== undefined) {
    if (typeof r.country !== "string" || !/^[A-Za-z]{2}$/.test(r.country)) {
      return { ok: false, error: "country must be a 2-letter ISO 3166-1 code" };
    }
    // Store uppercase so holidayRegionForCountry + dropdowns stay consistent.
    out.country = r.country.toUpperCase();
  }
  if (r.timezone !== undefined) {
    if (typeof r.timezone !== "string" || !isValidIanaTimezone(r.timezone)) {
      return { ok: false, error: "timezone must be a valid IANA zone (e.g. Europe/London)" };
    }
    out.timezone = r.timezone;
  }
  if (r.dateFormat !== undefined) {
    if (
      r.dateFormat !== "dd/mm/yyyy" &&
      r.dateFormat !== "mm/dd/yyyy" &&
      r.dateFormat !== "yyyy-mm-dd"
    ) {
      return { ok: false, error: "dateFormat invalid" };
    }
    out.dateFormat = r.dateFormat;
  }
  if (r.numberFormat !== undefined) {
    if (
      r.numberFormat !== "1,234.56" &&
      r.numberFormat !== "1.234,56" &&
      r.numberFormat !== "1 234,56"
    ) {
      return { ok: false, error: "numberFormat invalid" };
    }
    out.numberFormat = r.numberFormat;
  }
  if (r.weekStart !== undefined) {
    if (r.weekStart !== "monday" && r.weekStart !== "sunday") {
      return { ok: false, error: "weekStart must be monday or sunday" };
    }
    out.weekStart = r.weekStart;
  }
  if (r.fiscalYearStartMonth !== undefined) {
    const n = r.fiscalYearStartMonth;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 12) {
      return { ok: false, error: "fiscalYearStartMonth must be 1-12" };
    }
    out.fiscalYearStartMonth = n;
  }
  if (r.agentLocale !== undefined) {
    if (!SUPPORTED_AGENT_LOCALES.includes(r.agentLocale as WorkspaceSettings["agentLocale"])) {
      return { ok: false, error: "agentLocale not supported" };
    }
    out.agentLocale = r.agentLocale as WorkspaceSettings["agentLocale"];
  }
  if (r.agentPersona !== undefined) {
    if (!SUPPORTED_AGENT_PERSONAS.includes(r.agentPersona as WorkspaceSettings["agentPersona"])) {
      return { ok: false, error: "agentPersona not supported" };
    }
    out.agentPersona = r.agentPersona as WorkspaceSettings["agentPersona"];
  }

  return { ok: true, value: out };
}

/**
 * Merge a partial stored settings object with the defaults to produce
 * a full WorkspaceSettings record. Always returns a complete object,
 * so call sites don't need to defend against undefined per-field.
 *
 * Use this anywhere settings are read — agent prompt, chart renderer,
 * settings page — so the same default falls back across the app.
 */
export function mergeSettings(
  stored?: Partial<WorkspaceSettings> | null
): WorkspaceSettings {
  if (!stored) return { ...DEFAULT_WORKSPACE_SETTINGS };
  return { ...DEFAULT_WORKSPACE_SETTINGS, ...stored };
}

/**
 * Map a WorkspaceSettings to the Intl locale string used by chart and
 * table renderers when formatting numbers, currency, and dates. Pulled
 * from agentLocale because that's the one the customer explicitly
 * picked; using the BCP-47 form here means Intl.NumberFormat and
 * Intl.DateTimeFormat agree with how the agent talks.
 */
export function intlLocaleFor(settings: WorkspaceSettings): string {
  return settings.agentLocale;
}
