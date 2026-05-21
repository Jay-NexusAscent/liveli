/**
 * PII heuristic redaction for the metadata agent's sample_rows tool.
 *
 * The agent gets to see real rows so it can write meaningful column
 * descriptions, but we redact obviously-sensitive values before they
 * cross the LLM boundary. This is defence-in-depth: an attacker who
 * convinced the agent to leak data still couldn't leak email addresses
 * or credit-card numbers because the agent never saw them in clear.
 *
 * Two layers:
 *   1. Column-name pass — if the column is named like a secret, redact
 *      every value in that column unconditionally.
 *   2. Value-pattern pass — even on innocuous-looking columns, redact
 *      values that look like emails, credit-card numbers, or SSNs.
 *
 * Conservative on purpose: we over-redact rather than risk missing
 * a sensitive field. False positives produce `<redacted>` placeholders;
 * the agent's description quality degrades gracefully ("contains
 * redacted values; appears to be a contact field") rather than leaking.
 */

const SENSITIVE_COLUMN_NAME =
  /^(?:.*_)?(password|passwd|pwd|token|secret|api_?key|ssn|nin|tin|sin|cpf|nif|credit_?card|cc_?num|cvv|cvc|pin|auth_?key|access_?key|refresh_?token|private_?key|client_?secret|webhook_?secret)(_.*)?$/i;

const PII_COLUMN_NAME =
  /^(?:.*_)?(email|e_?mail|phone|mobile|telephone|address|street|postcode|zip|ip_?addr|ip_?address|dob|date_?of_?birth|first_?name|last_?name|full_?name|surname|given_?name)(_.*)?$/i;

const EMAIL_PATTERN = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i;

const CREDIT_CARD_PATTERN =
  /\b(?:\d[ \-]*?){13,19}\b/;

// Conservative SSN/NIN patterns. We don't try to validate — just match shapes.
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const NIN_PATTERN = /\b[A-Z]{2}\d{6}[A-Z]\b/;

export type ScrubLevel = "redact-all" | "redact-pii" | "passthrough";

function classifyColumn(name: string): ScrubLevel {
  if (SENSITIVE_COLUMN_NAME.test(name)) return "redact-all";
  if (PII_COLUMN_NAME.test(name)) return "redact-pii";
  return "passthrough";
}

function looksLikePii(value: string): boolean {
  if (EMAIL_PATTERN.test(value)) return true;
  if (SSN_PATTERN.test(value)) return true;
  if (NIN_PATTERN.test(value)) return true;
  // Strip spaces/dashes before testing credit-card to catch "4111 1111 1111 1111".
  const compact = value.replace(/[ \-]/g, "");
  if (CREDIT_CARD_PATTERN.test(compact) && /^\d{13,19}$/.test(compact)) {
    return true;
  }
  return false;
}

function scrubValue(value: unknown, level: ScrubLevel): unknown {
  if (level === "passthrough") {
    if (typeof value === "string" && looksLikePii(value)) return "<redacted>";
    return value;
  }
  if (level === "redact-all") return "<redacted>";
  // redact-pii: replace structured PII, leave numbers / shorter strings.
  if (typeof value === "string") {
    if (looksLikePii(value)) return "<redacted>";
    // For PII-likely columns (phone, name), redact non-empty strings entirely
    // — we can't reliably tell a "Jane Doe" from a meaningful label.
    if (value.length > 0) return "<redacted>";
  }
  return value;
}

/**
 * Scrub a batch of rows. Column scrub levels are computed once per
 * call from the schema's column names; per-value scanning still runs
 * on passthrough columns to catch PII that landed in unexpected places
 * (e.g. an email in a `notes` field).
 */
export function scrubSampleRows(
  rows: Record<string, unknown>[],
  columnNames: string[],
): Record<string, unknown>[] {
  const levels = new Map<string, ScrubLevel>();
  for (const name of columnNames) {
    levels.set(name, classifyColumn(name));
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [col, val] of Object.entries(row)) {
      out[col] = scrubValue(val, levels.get(col) ?? "passthrough");
    }
    return out;
  });
}
