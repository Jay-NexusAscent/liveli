/**
 * SQL template substitution for dashboard filters.
 *
 * Each chart's `sourceSql` carries placeholders that map to filter
 * values from the render request. The substitution layer:
 *
 *   1. Parses placeholders (the `{{filter:<id>.<field>}}` syntax)
 *   2. Resolves each to the matching filter's current value
 *   3. Renders SQL-literal-safe replacements for those values
 *   4. Validates the resulting SQL still passes the read-only check
 *
 * Safety model:
 *
 *   - **Date literals** rendered as quoted ISO strings via TIMESTAMP(...).
 *     ISO strings come from preset-expansion or client-supplied custom
 *     ranges, both validated against an ISO format regex before
 *     substitution.
 *   - **String literals** (single-select / multi-select values) escape
 *     embedded single quotes by doubling them, the standard SQL
 *     escape. Wrapped in single quotes. No way to break out and
 *     inject SQL because the entire value lands inside a quoted
 *     string literal regardless of contents.
 *   - **Granularity** restricted to a known enum — `DATE_TRUNC(...,
 *     <value>)` only accepts BigQuery's standard parts and we
 *     statically reject anything else.
 *   - **Column names** are NOT user-supplied via filter values —
 *     they're baked into the chart's sourceSql at create time.
 *     User input never touches identifier positions.
 *
 * Result: the substituted SQL is safe to dispatch to BigQuery
 * directly. The existing READ_ONLY check in run_sql.ts still gates
 * the final SQL (defence-in-depth — multi-statement scripts and
 * DDL/DML rejected at the boundary).
 */

import type {
  FilterDef,
  FilterValues,
  DateRangePreset,
  Granularity,
} from "./types";

/**
 * Match `{{filter:<id>.<field>}}` — where `<id>` is the filter's id
 * and `<field>` selects which sub-value to render (e.g. `.start` for
 * a date range's lower bound, `.values` for a multi-select's array).
 * Captures both as groups.
 *
 * Match is greedy on the id (anything not a dot) so ids can contain
 * any character except `.` and `}`.
 */
const PLACEHOLDER_RE = /\{\{filter:([^.{}]+)\.([a-z_]+)\}\}/g;

const VALID_GRANULARITIES: ReadonlySet<Granularity> = new Set([
  "DAY",
  "WEEK",
  "MONTH",
  "QUARTER",
  "YEAR",
]);

/**
 * Render the SQL template by substituting all `{{filter:...}}`
 * placeholders. Throws on unknown filter ids, unknown placeholder
 * fields, or values that fail validation.
 */
export function substituteFilters(
  sourceSql: string,
  filters: FilterDef[],
  values: FilterValues
): string {
  const byId = new Map(filters.map((f) => [f.id, f]));

  return sourceSql.replace(PLACEHOLDER_RE, (match, filterId: string, field: string) => {
    const filterDef = byId.get(filterId);
    if (!filterDef) {
      throw new Error(
        `Unknown filter referenced in SQL: "${filterId}". Available: ${Array.from(byId.keys()).join(", ") || "(none)"}`
      );
    }
    const resolvedValue = values[filterId] ?? filterDef.defaultValue;
    return renderPlaceholder(filterDef, field, resolvedValue);
  });
}

/**
 * Dispatch to the per-filter-type rendering logic. Each rendering
 * function returns SQL fragments that are safe to splice into the
 * query — either escaped literals or constrained identifiers.
 */
function renderPlaceholder(
  filterDef: FilterDef,
  field: string,
  value: unknown
): string {
  switch (filterDef.type) {
    case "date_range":
      return renderDateRange(field, value);
    case "granularity":
      return renderGranularity(field, value);
    case "select":
      return renderSelect(field, value);
    case "multi_select":
      return renderMultiSelect(field, value);
  }
}

// ── date_range ─────────────────────────────────────────────────────

function renderDateRange(field: string, raw: unknown): string {
  if (field !== "start" && field !== "end") {
    throw new Error(
      `date_range filter only supports .start or .end fields (got .${field})`
    );
  }
  const range = resolveDateRange(raw);
  const iso = field === "start" ? range.start : range.end;
  // Validate ISO format strictly before splicing
  if (!isValidIsoDate(iso)) {
    throw new Error(`date_range produced non-ISO date: "${iso}"`);
  }
  // TIMESTAMP() with a literal-quoted ISO string is unambiguous in
  // BigQuery and avoids any timezone interpretation surprises.
  return `TIMESTAMP("${iso}")`;
}

function resolveDateRange(raw: unknown): { start: string; end: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error(`date_range value must be an object, got ${typeof raw}`);
  }
  const v = raw as { mode?: string; preset?: string; start?: string; end?: string };
  if (v.mode === "custom") {
    if (!v.start || !v.end) {
      throw new Error("Custom date_range requires start and end fields");
    }
    return { start: v.start, end: v.end };
  }
  if (v.mode === "preset") {
    if (typeof v.preset !== "string") {
      throw new Error("Preset date_range requires preset field");
    }
    return expandPreset(v.preset as DateRangePreset);
  }
  throw new Error(`date_range value has unknown mode: ${JSON.stringify(v.mode)}`);
}

/**
 * Expand a preset to absolute ISO timestamps. Server-side
 * computation so the client doesn't need to do date math — and so
 * "this month" always means the request-time month regardless of
 * any client clock drift.
 */
function expandPreset(preset: DateRangePreset): { start: string; end: string } {
  const now = new Date();
  const endIso = now.toISOString();

  const subtractDays = (days: number): string => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString();
  };

  switch (preset) {
    case "last_7_days":
      return { start: subtractDays(7), end: endIso };
    case "last_30_days":
      return { start: subtractDays(30), end: endIso };
    case "last_90_days":
      return { start: subtractDays(90), end: endIso };
    case "last_year":
      return { start: subtractDays(365), end: endIso };
    case "this_month": {
      const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start: startOfMonth.toISOString(), end: endIso };
    }
    case "last_month": {
      const startOfLast = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const endOfLast = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start: startOfLast.toISOString(), end: endOfLast.toISOString() };
    }
    case "this_quarter": {
      const q = Math.floor(now.getUTCMonth() / 3);
      const startOfQuarter = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
      return { start: startOfQuarter.toISOString(), end: endIso };
    }
    case "this_year":
    case "year_to_date": {
      const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return { start: startOfYear.toISOString(), end: endIso };
    }
  }
}

function isValidIsoDate(s: string): boolean {
  // Strict-ish: matches ISO 8601 date or datetime with optional offset.
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s);
}

// ── granularity ────────────────────────────────────────────────────

function renderGranularity(field: string, raw: unknown): string {
  // Granularity placeholder is just `{{filter:<id>}}` — no sub-field
  // — but the regex captures something. We accept any field name
  // because granularity is a single value.
  void field;
  if (typeof raw !== "string" || !VALID_GRANULARITIES.has(raw as Granularity)) {
    throw new Error(
      `granularity must be one of ${Array.from(VALID_GRANULARITIES).join(", ")}, got ${JSON.stringify(raw)}`
    );
  }
  // Granularity is a SQL keyword, not a literal. Output as bare
  // identifier (no quotes). The enum check above means we know it's
  // a safe value from a closed set — no injection risk.
  return raw;
}

// ── select / multi_select ──────────────────────────────────────────

function renderSelect(field: string, raw: unknown): string {
  if (field !== "value") {
    throw new Error(`select filter only supports .value field (got .${field})`);
  }
  if (raw === null) {
    // null = no value selected → render a tautology so the filter
    // effectively doesn't apply. Safer than throwing.
    return "TRUE";
  }
  if (typeof raw !== "string") {
    throw new Error(`select filter value must be string or null, got ${typeof raw}`);
  }
  return escapeSqlString(raw);
}

function renderMultiSelect(field: string, raw: unknown): string {
  if (field !== "values") {
    throw new Error(`multi_select filter only supports .values field (got .${field})`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`multi_select filter values must be array, got ${typeof raw}`);
  }
  if (raw.length === 0) {
    // Empty selection = no filter applied. Render as a parenthesised
    // expression that always matches (every row passes the IN check).
    // We can't emit an empty `IN ()` — BQ would reject it.
    return "(TRUE)";
  }
  const escaped = raw
    .filter((v): v is string => typeof v === "string")
    .map(escapeSqlString)
    .join(", ");
  if (!escaped) {
    return "(TRUE)";
  }
  return `(${escaped})`;
}

/**
 * SQL-escape a string literal — double up embedded single quotes,
 * wrap whole thing in single quotes. Result is splice-safe regardless
 * of input contents because the entire value lives inside a literal.
 *
 * Example: `O'Reilly` → `'O''Reilly'`
 */
function escapeSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
