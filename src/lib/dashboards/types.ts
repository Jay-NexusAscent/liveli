/**
 * Dashboard filter type definitions — Phase 1 of LIVELI-122.
 *
 * These shape what gets stored in Firestore on a dashboard doc AND
 * what the render endpoint accepts as filter values from the client.
 *
 * Persistence layout (Phase 1):
 *   dashboards/{dashboardId} {
 *     ...existing fields,
 *     filters?: FilterDef[],   // definitions — names, columns, defaults
 *     charts: ChartEntry[],    // each chart may now carry sourceSql + dataMapping
 *   }
 *
 * The `defaultValue` on each FilterDef is used when the client
 * doesn't pass an explicit value. localStorage-per-browser
 * persistence (per the Phase 1 design decision) lives on the client
 * side — the server only sees: defaults from the dashboard doc, or
 * the values the client passes in the render request.
 */

/**
 * Time-range filter — covers "last 7/30/90 days", "this month",
 * "this quarter", "YTD", or a custom date range. Drives any chart
 * whose sourceSql references `{{filter:date_range.start}}` and
 * `{{filter:date_range.end}}`.
 */
export interface DateRangeFilterDef {
  id: string;
  type: "date_range";
  /** Display label, e.g. "Date range". */
  label: string;
  /**
   * Default value applied when the client doesn't pass an explicit
   * one. `preset` references a server-resolved range (e.g.
   * `last_30_days` → today minus 30 days through today).
   */
  defaultValue:
    | { mode: "preset"; preset: DateRangePreset }
    | { mode: "custom"; start: string; end: string };
}

export type DateRangePreset =
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "last_year"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "this_year"
  | "year_to_date";

/**
 * Granularity filter — typically paired with a date_range filter on
 * time-series charts. Substitutes into `{{filter:granularity}}` in
 * the chart's sourceSql, expanding to a BigQuery date-truncation
 * function (e.g. "DAY" → `DATE_TRUNC(placed_at, DAY)`).
 */
export interface GranularityFilterDef {
  id: string;
  type: "granularity";
  label: string;
  defaultValue: Granularity;
}

export type Granularity = "DAY" | "WEEK" | "MONTH" | "QUARTER" | "YEAR";

/**
 * Single-select dimension filter (e.g. "Channel = web"). Substitutes
 * into `{{filter:<id>.value}}` as a quoted SQL literal.
 */
export interface SelectFilterDef {
  id: string;
  type: "select";
  label: string;
  /** The actual column to filter on, fully-qualified or just bare name. */
  column: string;
  /** All available values — populated by the agent or the user. */
  options: string[];
  defaultValue: string | null;
}

/**
 * Multi-select dimension filter (e.g. "Channel IN (web, mobile)").
 * Substitutes into `{{filter:<id>.values}}` as a parenthesised list
 * of quoted SQL literals.
 */
export interface MultiSelectFilterDef {
  id: string;
  type: "multi_select";
  label: string;
  column: string;
  options: string[];
  /** Empty array = no filter applied (all options included). */
  defaultValue: string[];
}

export type FilterDef =
  | DateRangeFilterDef
  | GranularityFilterDef
  | SelectFilterDef
  | MultiSelectFilterDef;

/**
 * Client-supplied filter values per render request. Keyed by filter
 * id. Server-side validates each value against the matching FilterDef
 * before substitution.
 *
 * If a filter id is missing from the request, the server falls back
 * to the FilterDef.defaultValue.
 */
export interface FilterValues {
  [filterId: string]:
    | { mode: "preset"; preset: DateRangePreset }
    | { mode: "custom"; start: string; end: string }
    | Granularity
    | string
    | string[]
    | null;
}

/**
 * Dynamic chart entry — extends the existing make_dashboard chart
 * shape with the bits needed to re-render under filter values.
 *
 * `sourceSql` is the parameterised query template. `dataMapping`
 * tells the render endpoint how to assemble chart-spec fields from
 * the query result columns. The combination of these two fields
 * makes a chart "live" — re-runs under different filter values
 * produce a refreshed ECharts option.
 *
 * Charts WITHOUT sourceSql/dataMapping continue to render statically
 * from their saved spec, preserving full backward compatibility for
 * dashboards created before LIVELI-122.
 */
export interface DynamicChartEntry {
  order: number;
  title: string;
  /** Original/last-rendered chart spec — static fallback when no sourceSql. */
  spec: unknown;
  colSpan?: "small" | "medium" | "large";
  /**
   * Parameterised SQL template. Placeholders are `{{filter:<id>.<field>}}`
   * — substituted by the render endpoint before execution.
   */
  sourceSql?: string;
  /**
   * Maps result-column names to chart-spec positions. Drives how the
   * SQL output rebuilds the ECharts option after a fresh run.
   *
   * Example for a time-series line chart:
   *   {
   *     xAxis: { dataColumn: "month" },
   *     series: [{ dataColumn: "monthly_revenue" }],
   *   }
   *
   * Example for a multi-series bar chart:
   *   {
   *     xAxis: { dataColumn: "category" },
   *     series: [
   *       { dataColumn: "web_revenue", name: "Web" },
   *       { dataColumn: "mobile_revenue", name: "Mobile" },
   *     ],
   *   }
   */
  dataMapping?: ChartDataMapping;
}

export interface ChartDataMapping {
  xAxis?: { dataColumn: string };
  series: Array<{
    dataColumn: string;
    name?: string;
  }>;
}
