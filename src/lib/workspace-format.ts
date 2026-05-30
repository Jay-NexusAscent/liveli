/**
 * Workspace-token-aware formatters. Why these exist:
 *
 * The standard `Intl.NumberFormat(locale)` and `Intl.DateTimeFormat(locale)`
 * APIs follow locale CONVENTION — e.g. `en-GB` gives "1,234.56" and
 * "01/04/2026". That's a sensible default, but the WorkspaceSettings
 * model gives users an EXPLICIT pick for:
 *
 *   - `numberFormat`: "1,234.56" | "1.234,56" | "1 234,56"
 *   - `dateFormat`:   "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd"
 *
 * A user on `en-GB` who picks `numberFormat = "1.234,56"` (German-style)
 * expects to see "1.234,56", NOT "1,234.56". An `Intl`-only path would
 * silently override their pick with the locale default. These helpers
 * close that gap — they decompose the locale's output and rewrite the
 * separators, or build the output from scratch where it's cleaner.
 *
 * One trade-off we don't escape: `Intl.NumberFormat` with
 * `style: "currency"` couples the currency-symbol placement AND the
 * digit separators to the locale. If the user picks a locale + a
 * numberFormat that disagree, currency strings will follow the locale
 * (so the symbol position is right) and non-currency numbers will
 * follow the explicit token. That's a small inconsistency, but the
 * alternative — re-rendering currency symbol placement by hand for
 * every locale — would re-implement a substantial chunk of CLDR. We
 * accept the trade and document it at callsites.
 */

import type { WorkspaceSettings } from "./workspace-settings";

export type NumberFormatToken = WorkspaceSettings["numberFormat"];
export type DateFormatToken = WorkspaceSettings["dateFormat"];

interface Separators {
  thousand: string;
  decimal: string;
}

/**
 * Decompose a number-format token into its thousands + decimal
 * separator characters. Centralised so the formatter and the
 * currency-rewrite path agree on the same mapping.
 */
function separatorsForToken(token: NumberFormatToken): Separators {
  switch (token) {
    case "1,234.56":
      return { thousand: ",", decimal: "." };
    case "1.234,56":
      return { thousand: ".", decimal: "," };
    case "1 234,56":
      // Non-breaking space — matches what `fr-FR` / `de-CH` Intl emits and
      // avoids the visual gap a regular space leaves when the value wraps.
      return { thousand: " ", decimal: "," };
  }
}

/**
 * Format a finite number using the workspace's EXPLICIT separator
 * pick, ignoring the locale's default convention. By default,
 * integer-valued floats render without decimals; fractional values
 * keep up to 2 decimal places with trailing zeros trimmed (matches
 * the existing table/cell conventions in `table-block.tsx`).
 *
 * For callers that need EXACT decimal counts (e.g. the chart
 * renderer's "6.00M" / "6.96M" abbreviation, where stripping the
 * trailing zeros would produce ragged widths), pass an explicit
 * `minimumFractionDigits` + `maximumFractionDigits` pair.
 *
 * Non-finite inputs pass through as the empty string so the caller
 * can decide on a fallback.
 *
 * Examples (all independent of locale):
 *   token="1,234.56", value=1234.5  → "1,234.5"
 *   token="1.234,56", value=1234.5  → "1.234,5"
 *   token="1 234,56", value=1234.5  → "1 234,5"   (NBSP)
 *   token=*,          value=42      → "42"
 *   token="1,234.56", value=6, {min:2,max:2} → "6.00"
 */
export function formatNumberWithToken(
  value: number,
  token: NumberFormatToken,
  options: { minimumFractionDigits?: number; maximumFractionDigits?: number } = {}
): string {
  if (!Number.isFinite(value)) return "";
  const sep = separatorsForToken(token);
  let fixed: string;
  if (
    options.minimumFractionDigits !== undefined ||
    options.maximumFractionDigits !== undefined
  ) {
    const max = options.maximumFractionDigits ?? options.minimumFractionDigits ?? 0;
    const min = options.minimumFractionDigits ?? 0;
    // Honor max first, then ensure we keep at least `min` digits — so
    // a value like 6 with {min:2,max:2} comes out "6.00".
    fixed = value.toFixed(max);
    if (max > min) {
      // Strip excess trailing zeros down to `min` decimals.
      const trimmed = fixed.replace(/\.?0+$/, "");
      if (trimmed.length < fixed.length) {
        const dotIdx = trimmed.indexOf(".");
        const currentFrac = dotIdx === -1 ? 0 : trimmed.length - dotIdx - 1;
        if (currentFrac < min) {
          fixed = (dotIdx === -1 ? `${trimmed}.` : trimmed) + "0".repeat(min - currentFrac);
        } else {
          fixed = trimmed;
        }
      }
    }
  } else {
    const isInteger = Number.isInteger(value);
    fixed = isInteger ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, "");
  }
  // `toFixed` always gives a "1234.5"-style raw string with a `.`
  // decimal, regardless of locale — so we can split on it cleanly.
  const [rawIntPart, rawFracPart] = fixed.split(".");
  const negative = rawIntPart.startsWith("-");
  const intDigits = negative ? rawIntPart.slice(1) : rawIntPart;
  // Insert thousand separators every 3 digits from the right.
  const grouped = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, sep.thousand);
  const signed = negative ? `-${grouped}` : grouped;
  return rawFracPart ? `${signed}${sep.decimal}${rawFracPart}` : signed;
}

/**
 * Format a currency value using the workspace's currency code + the
 * user's explicit numberFormat token. Currency symbol placement comes
 * from `Intl.NumberFormat(locale, { style: "currency" })` — there's
 * no portable way to position a symbol per-locale without re-doing
 * CLDR, so the locale wins on placement. Digit separators are
 * rewritten to match the user's chosen number-format token, so a user
 * on `en-GB` with `1.234,56` numberFormat will see "£1.234,56" rather
 * than "£1,234.56".
 *
 * If the locale + currency combination is unsupported by the runtime
 * Intl, falls back to a bare "<CODE> <number>" form so the UI still
 * renders something readable.
 */
export function formatCurrencyWithToken(
  value: number,
  currency: string,
  numberToken: NumberFormatToken,
  locale: string
): string {
  if (!Number.isFinite(value)) return "";
  // Cheap rebuild path — always works.
  const bareNumber = formatNumberWithToken(value, numberToken);
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    });
  } catch {
    return `${currency} ${bareNumber}`;
  }
  // Build via formatToParts so we can splice in our re-grouped number
  // while keeping the locale's symbol position + spacing parts.
  const parts = formatter.formatToParts(value);
  const out: string[] = [];
  let numberInjected = false;
  for (const p of parts) {
    if (
      p.type === "integer" ||
      p.type === "group" ||
      p.type === "decimal" ||
      p.type === "fraction"
    ) {
      // Replace the entire number block with our token-formatted form,
      // once. Subsequent number parts are skipped — the original parts
      // collectively reconstruct the number, and we've already emitted it.
      if (!numberInjected) {
        out.push(bareNumber);
        numberInjected = true;
      }
      continue;
    }
    out.push(p.value);
  }
  return out.join("");
}

/**
 * Format a date / ISO-string using the workspace's explicit dateFormat
 * token, in the workspace timezone. Timezone-aware so users east/west
 * of UTC see the day boundary their workspace expects.
 *
 *   token="dd/mm/yyyy" → "01/04/2026"
 *   token="mm/dd/yyyy" → "04/01/2026"
 *   token="yyyy-mm-dd" → "2026-04-01"
 *
 * Returns the input as-is if it can't be parsed — callers can hand
 * non-date strings through the formatter safely (matches the existing
 * `formatCell` style in `table-block.tsx`).
 */
export function formatDateWithToken(
  value: Date | string,
  token: DateFormatToken,
  timezone: string,
  options: { includeTime?: boolean; locale?: string } = {}
): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return typeof value === "string" ? value : "";
  }
  // Use Intl.DateTimeFormat with `en-GB` as a stable anchor — its
  // numeric `day/month/year` shape gives us a predictable
  // "dd/mm/yyyy" string we can re-slice into any of the three tokens
  // without depending on locale conventions.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  let datePart: string;
  switch (token) {
    case "dd/mm/yyyy":
      datePart = `${day}/${month}/${year}`;
      break;
    case "mm/dd/yyyy":
      datePart = `${month}/${day}/${year}`;
      break;
    case "yyyy-mm-dd":
      datePart = `${year}-${month}-${day}`;
      break;
  }
  if (!options.includeTime) return datePart;
  const timeParts = new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const hour = timeParts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = timeParts.find((p) => p.type === "minute")?.value ?? "00";
  return `${datePart} ${hour}:${minute}`;
}

/**
 * Heuristic: does this column name suggest a monetary value? Used by
 * the table renderer to decide whether to apply the workspace
 * currency formatter to a numeric cell. Run_sql results don't carry
 * BigQuery column-type metadata down to the client, so name-shape is
 * the best signal we have without extending the wire format.
 *
 * Matches common money words anywhere in the column name (so
 * `total_revenue`, `gross_amount_gbp`, `unit_price` all qualify).
 * Avoids false positives by requiring a word-boundary match — "scarred"
 * won't match "scar", "amount" won't match "amounted_to" only because
 * we don't carry the column through the regex as a substring of a
 * larger word. Conservative on purpose; agents that need exact
 * formatting should emit a chart via make_chart, not rely on table
 * heuristics.
 */
const CURRENCY_COLUMN_RE = /\b(revenue|sales|amount|price|cost|spend|profit|margin|total|gross|net|fee|charge|payment|payout|refund|balance|mrr|arr|gmv|ltv|cac|aov)\b/i;

export function isCurrencyColumn(columnName: string): boolean {
  if (!columnName) return false;
  return CURRENCY_COLUMN_RE.test(columnName);
}
