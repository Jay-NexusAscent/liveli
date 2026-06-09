"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceSettings,
} from "@/lib/workspace-settings";
import {
  currencySymbolFor,
  formatDateWithToken,
  formatNumberWithToken,
  formatPercentValue,
} from "@/lib/workspace-format";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

/**
 * Live `data-theme` subscription.
 *
 * ECharts bakes its theme (light/dark palette + canvas background) in
 * at instantiation. If we read `data-theme` only once at mount, a chart
 * created while the page was dark keeps its dark navy canvas after the
 * user toggles to light — it never re-instantiates. Subscribing to the
 * attribute (and the cross-tab `storage` event the toggle dispatches)
 * makes ChartRenderer re-render on every theme change, which flips the
 * `theme` prop and prompts echarts-for-react to recreate the instance
 * with the correct palette.
 */
function subscribeTheme(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    window.removeEventListener("storage", callback);
    observer.disconnect();
  };
}

function getThemeSnapshot(): "light" | "dark" {
  // Default to light when data-theme is absent/unknown, matching the
  // toggle, the server snapshot, and layout.tsx's init script. Defaulting
  // to dark here desynced charts (dark) from the toggle symbol (light).
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

// Light is the default theme (see layout.tsx); match it on the server so
// SSR markup and first client paint agree.
function getThemeServerSnapshot(): "light" | "dark" {
  return "light";
}

interface SeriesLike {
  type?: string;
  data?: unknown[];
  name?: string;
  format?: "number" | "currency" | "percent";
  unit?: string;
  delta?: number;
  deltaLabel?: string;
  /**
   * Optional per-series currency override. Used when a connector
   * reports its own currency (e.g. Stripe charges, Shopify orders) so
   * the chart shows "$123" even if the workspace default is GBP. When
   * absent, the workspace setting wins. ISO 4217 string.
   */
  currency?: string;
}

interface ChartSpecLike {
  series?: SeriesLike[];
  // Other ECharts fields are passed straight through.
  [k: string]: unknown;
}

interface ChartRendererProps {
  spec: unknown;
  height?: number;
  /**
   * Workspace-level regional preferences — drives currency symbol,
   * locale-aware number formatting, and date-axis timezone. When
   * omitted, falls back to DEFAULT_WORKSPACE_SETTINGS (GBP / Europe-
   * London / en-GB) so legacy call sites keep working unchanged.
   */
  settings?: WorkspaceSettings;
  /**
   * Thumbnail mode for the dashboards gallery mini-grid. Strips axis
   * labels, legend, title and tooltips, and shrinks the KPI headline so
   * 6+ charts read as a clean miniature dashboard rather than a wall of
   * clipped giant numbers and overlapping tick labels.
   */
  preview?: boolean;
}

/**
 * Single shared chart renderer used by ChartBlock (inline chat),
 * DashboardBlock (mini-grid in chat), FullscreenModal (expanded
 * overlay), and the Dashboards page ChartTile. Centralising it here
 * means a new chart type (KPI tile, donut, etc.) lands once and shows
 * up everywhere.
 *
 * Dispatch:
 *   - series[0].type === "kpi"   → KpiTile (custom React, no ECharts)
 *   - series[0].type === "donut" → ECharts pie with inner-radius
 *   - everything else            → ECharts straight-through
 *
 * The decision is based on the FIRST series entry — a chart spec
 * shouldn't mix kpi with other types, and donut-vs-pie applies to
 * the whole series array.
 */
export function ChartRenderer({
  spec,
  height = 320,
  settings = DEFAULT_WORKSPACE_SETTINGS,
  preview = false,
}: ChartRendererProps) {
  // Subscribe to live theme changes. Must run before any early return
  // (rules of hooks). KpiTile is plain React and ignores it.
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot
  );

  const chartSpec = (spec as ChartSpecLike) ?? {};
  const firstSeries = chartSpec.series?.[0];

  if (firstSeries?.type === "kpi") {
    return (
      <KpiTile series={firstSeries} height={height} settings={settings} preview={preview} />
    );
  }

  // Apply universal polish to every non-KPI spec: smooth defaults on
  // line/area series + ISO-timestamp formatting on category-axis
  // labels. Donut translation runs after so it operates on a spec
  // that already has the polish baked in.
  const polished = polishChartSpec(chartSpec, settings);
  const firstType = polished.series?.[0]?.type;
  const composed =
    firstType === "donut" || firstType === "pie"
      ? toPieOption(polished)
      : polished;
  const echartsOption = preview ? stripChromeForPreview(composed) : composed;

  return (
    <ReactECharts
      option={echartsOption as object}
      style={{ height, width: "100%" }}
      theme={theme === "light" ? "default" : "dark"}
      opts={{ renderer: "svg" }}
    />
  );
}

/**
 * Strip a composed ECharts option down to its data shape for the
 * dashboards gallery thumbnail: no axis labels/ticks/lines, no legend,
 * title, tooltip or series labels, and a tight flush grid. The result
 * is a clean sparkline-ish miniature — readable at ~60px tall where the
 * full chart's labels would overlap into noise.
 */
function stripChromeForPreview(option: Record<string, unknown>): Record<string, unknown> {
  const stripAxis = (ax: unknown): unknown => {
    if (!ax || typeof ax !== "object") return ax;
    if (Array.isArray(ax)) return ax.map(stripAxis);
    return {
      ...(ax as Record<string, unknown>),
      name: undefined,
      axisLabel: { show: false },
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { show: false },
    };
  };
  const series = Array.isArray(option.series)
    ? (option.series as Record<string, unknown>[]).map((s) => ({
        ...s,
        label: { show: false },
        labelLine: { show: false },
      }))
    : option.series;
  return {
    ...option,
    title: undefined,
    legend: undefined,
    tooltip: undefined,
    grid: { left: 4, right: 4, top: 6, bottom: 4, containLabel: false },
    xAxis: stripAxis(option.xAxis),
    yAxis: stripAxis(option.yAxis),
    series,
  };
}

/**
 * Render a KPI tile: large headline number (centre-aligned, auto-
 * abbreviated when large), optional unit/format, optional delta with
 * up/down arrow + caption.
 *
 * Why centre-aligned: matches every other analytics product's KPI
 * pattern (Datadog, Looker, Mixpanel). Left-aligned numbers in a
 * dashboard tile read as data points, not headlines.
 *
 * Why auto-abbreviation: a ¼-width tile in a 4-column grid is too
 * narrow for £6,960,836.71 (12 chars at 44px font = overflows into
 * the adjacent tile). £6.96M (5 chars) fits and reads faster anyway.
 * Abbreviation kicks in above 10,000; smaller numbers show full
 * thousand-separated form for precision.
 */
function KpiTile({
  series,
  height,
  settings,
  preview = false,
}: {
  series: SeriesLike;
  height: number;
  settings: WorkspaceSettings;
  preview?: boolean;
}) {
  const value = typeof series.data?.[0] === "number" ? (series.data[0] as number) : 0;
  const formatted = formatKpiValue(value, series.format, series.unit, series.currency, settings);
  const hasDelta = typeof series.delta === "number";
  const deltaPositive = hasDelta && (series.delta as number) > 0;
  const deltaNegative = hasDelta && (series.delta as number) < 0;
  const deltaFormatted =
    hasDelta && series.format === "percent"
      ? `${(series.delta as number) > 0 ? "+" : ""}${(series.delta as number).toFixed(1)}%`
      : hasDelta
      ? `${(series.delta as number) > 0 ? "+" : ""}${abbreviateNumber(series.delta as number, settings)}`
      : null;

  return (
    <div
      // Centre everything horizontally + vertically. min-w-0 + overflow
      // hidden on the inner number prevents bleed-into-adjacent-tile
      // even if abbreviation isn't enough (very long unit strings, etc).
      className="flex w-full flex-col items-center justify-center text-center"
      style={{ minHeight: height }}
    >
      <div
        className={`w-full max-w-full truncate font-semibold tracking-tight text-text-primary font-heading tabular-nums leading-none ${
          preview ? "text-[15px]" : "text-[36px]"
        }`}
        // title attribute exposes the full unformatted number for
        // accessibility / user hover-to-verify use cases. Honors the
        // workspace numberFormat token explicitly (the title is for
        // sighted hover + screen readers — both benefit from the user's
        // chosen separator convention, not the locale default).
        title={formatNumberWithToken(value, settings.numberFormat)}
      >
        {formatted}
      </div>
      {series.name && (
        <div
          className={`max-w-full truncate text-text-secondary ${
            preview ? "mt-1 text-[10px]" : "mt-2 text-[13px]"
          }`}
        >
          {series.name}
        </div>
      )}
      {!preview && hasDelta && deltaFormatted && (
        <div
          className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium tabular-nums ${
            deltaPositive
              ? "bg-[color:var(--status-success)]/12 text-[color:var(--status-success)]"
              : deltaNegative
              ? "bg-[color:var(--status-error)]/12 text-[color:var(--status-error)]"
              : "bg-elevated text-text-tertiary"
          }`}
        >
          <span aria-hidden>{deltaPositive ? "↑" : deltaNegative ? "↓" : "·"}</span>
          <span>{deltaFormatted}</span>
          {series.deltaLabel && (
            <span className="text-text-tertiary"> {series.deltaLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Abbreviate a number for compact display. Threshold tuned so values
 * below 10K still show full thousand-separated form (precise enough
 * to read at a glance), and above 10K we collapse to M / K / B form.
 *
 *   6_960_836  → "6.96M"
 *   37_113     → "37.1K"
 *   124_630    → "125K"
 *   8_632      → "8,632"     (below threshold, full form)
 *   1_500_000  → "1.50M"
 *   1_500_000_000 → "1.50B"
 *
 * Decimal count varies by magnitude — bigger values get 1 decimal
 * (124.6K reads cleaner than 124K), smaller chunky values get 2
 * (6.96M is more precise than 7M).
 *
 * Honors the workspace's numberFormat token so a user on "1.234,56"
 * sees "6,96M" instead of "6.96M" — `Intl` defaults to locale
 * convention, which would silently override the explicit token. See
 * `lib/workspace-format.ts` for the trade-off rationale.
 */
function abbreviateNumber(n: number, settings: WorkspaceSettings): string {
  const abs = Math.abs(n);
  const t = settings.numberFormat;
  if (abs >= 1_000_000_000) {
    return `${formatNumberWithToken(n / 1_000_000_000, t, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}B`;
  }
  if (abs >= 1_000_000) {
    return `${formatNumberWithToken(n / 1_000_000, t, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
  }
  if (abs >= 100_000) {
    return `${formatNumberWithToken(Math.round(n / 1_000), t)}K`;
  }
  if (abs >= 10_000) {
    return `${formatNumberWithToken(n / 1_000, t, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K`;
  }
  return formatNumberWithToken(n, t);
}

function formatKpiValue(
  value: number,
  format: "number" | "currency" | "percent" | undefined,
  unit: string | undefined,
  currencyOverride: string | undefined,
  settings: WorkspaceSettings
): string {
  if (format === "percent") {
    // Handle both common conventions defensively:
    //   - Fraction form (0.03 → 3.0%) — what SQL aggregates naturally
    //     produce, e.g. SUM(buyers) / COUNT(sessions) = 0.03
    //   - Already-percent form (3.0 → 3.0%) — what some agents emit
    //     when they multiply by 100 in SQL
    // Heuristic: if value is between -1 and 1 (exclusive of -1/1),
    // treat as fraction and multiply by 100. Otherwise treat as
    // already-percent. This covers >99% of real cases and produces
    // readable output for both conventions.
    const display = value > -1 && value < 1 ? value * 100 : value;
    return `${display.toFixed(1)}%`;
  }
  if (format === "currency") {
    // Resolve currency: per-series override (e.g. connector-reported
    // via make_chart) takes precedence, then workspace setting. Use
    // the locale's currency symbol via Intl, so a USD KPI on an en-GB
    // workspace shows "US$1.2M" rather than the bare prefix.
    const currency = currencyOverride ?? settings.currency;
    const abbreviated = abbreviateNumber(value, settings);
    let symbol = currency; // safe fallback
    try {
      // Render a tiny value purely to extract the currency symbol the
      // locale would use, then prefix our already-abbreviated number.
      // Doing it this way keeps the K / M / B abbreviation logic shared
      // with the non-currency code path AND honors the user's
      // numberFormat token via `abbreviateNumber`.
      const formatter = new Intl.NumberFormat(settings.agentLocale, {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
      });
      const parts = formatter.formatToParts(0);
      const sym = parts.find((p) => p.type === "currency")?.value;
      if (sym) symbol = sym;
    } catch {
      // Unknown currency code or unsupported locale — fall through with
      // the raw ISO code as the symbol.
    }
    return `${symbol}${abbreviated}`;
  }
  const abbreviated = abbreviateNumber(value, settings);
  return unit ? `${abbreviated}${unit}` : abbreviated;
}

/**
 * Strict ISO-8601 matcher — same regex as table-block.tsx. Anchored
 * so a category label that happens to contain a date-looking
 * substring (e.g. "Order 2026-04-01") isn't mis-detected.
 */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Render-time spec polish — applied to every non-KPI chart so the
 * agent can stay focused on data shape while presentation niceties
 * land uniformly across new and previously-saved charts.
 *
 * Two transformations:
 *
 * 1. Line / area series default to `smooth: true`. Curved lines read
 *    better than zig-zag polylines, especially for noisy time-series.
 *    Only sets when the series doesn't already declare a value, so an
 *    explicit `smooth: false` still wins.
 *
 * 2. Category-axis labels that look like ISO timestamps get a
 *    formatter installed so they display as "Apr 1, 00:00" instead of
 *    "2026-04-01T00:00:00.000Z", plus `hideOverlap: true` so ECharts
 *    drops crowded labels rather than rendering them on top of each
 *    other. The underlying xAxis.data stays as ISO strings — this is
 *    purely a display-layer change, so sorting / data joins still
 *    work on the raw values.
 *
 * Pure function: returns a new spec, doesn't mutate. The polish is
 * runtime-only (the `formatter` is a function, which doesn't
 * round-trip through JSON.stringify) — that's fine because we run
 * this at render time on every load, not at save time.
 */
function polishChartSpec(
  spec: ChartSpecLike,
  settings: WorkspaceSettings
): ChartSpecLike {
  const out: ChartSpecLike = { ...spec };

  // 0. Drop the in-chart title. Every surface that renders a chart —
  // dashboard tiles, chat blocks, the fullscreen modal, gallery
  // thumbnails — already shows the title in its own header/banner, so
  // an ECharts `title` just duplicates it and overlaps the plot area.
  (out as { title?: unknown }).title = undefined;

  // 1. Respect the spec's line smoothing. We used to force `smooth: true`
  // on every line/area series, but that misrepresents discrete daily/
  // weekly measurements (a curve invents values between points). Leave
  // it to the agent / editor — straight by default, smooth only when
  // explicitly requested.

  // 2. ISO-timestamp axis labels — bind the formatter to the
  // workspace's locale + timezone so en-US sees "Apr 1" while en-GB
  // sees "1 Apr", and timestamps render in the customer's chosen zone
  // rather than the browser's local zone. Returning a closure here
  // means the rendered axis automatically refreshes if the workspace
  // changes settings.
  const xAxis = out.xAxis as
    | { type?: string; data?: unknown[]; axisLabel?: Record<string, unknown> }
    | undefined;
  if (xAxis && Array.isArray(xAxis.data)) {
    const hasIsoData = xAxis.data.some(
      (v) => typeof v === "string" && ISO_DATE_RE.test(v)
    );
    if (hasIsoData) {
      const localeFormatter = (value: unknown) =>
        formatIsoAxisLabel(value, settings);
      out.xAxis = {
        ...xAxis,
        axisLabel: {
          ...(xAxis.axisLabel ?? {}),
          formatter: localeFormatter,
          hideOverlap: true,
        },
      };
    }
  }

  // 3. Axis-title presentation. The agent now sets `xAxis.name` /
  // `yAxis.name`; place and weight them like a BI tool would — x-title
  // centred under the axis, y-title centred up the side — and make sure
  // the grid leaves room so neither the title nor the value labels get
  // clipped. `containLabel` reserves space for the tick labels; we add
  // explicit margins on top so the axis NAMES (which containLabel does
  // NOT account for) have somewhere to sit.
  const hasAxes = Boolean(out.xAxis || out.yAxis);
  if (hasAxes) {
    out.xAxis = styleAxisName(out.xAxis as AxisLike | undefined, "x");
    out.yAxis = styleAxisName(out.yAxis as AxisLike | undefined, "y");
    const xHasName = Boolean((out.xAxis as AxisLike | undefined)?.name);
    const yHasName = Boolean((out.yAxis as AxisLike | undefined)?.name);
    const existingGrid = (out.grid as Record<string, unknown> | undefined) ?? {};
    // `containLabel` reserves room for the tick labels but NOT the axis
    // NAME (centred title), so the title clips off the canvas edge unless
    // we widen the margin on that side. Force a name-aware margin that
    // clears tick labels + the title's nameGap. These win over any
    // spec-provided grid (which spreads first) — otherwise a chart that
    // ships its own small `bottom` re-clips "Country" off the bottom.
    out.grid = {
      right: 24,
      top: 24,
      ...existingGrid,
      containLabel: true,
      bottom: xHasName ? 56 : (existingGrid.bottom ?? 16),
      left: yHasName ? 72 : (existingGrid.left ?? 16),
    };
  }

  // 4. Value formatting — currency symbol / percent / unit on the value
  // axis ticks AND the tooltip, for cartesian charts (bar/line/area/
  // scatter). Previously only KPI tiles formatted currency, so a "£"
  // chart showed bare numbers on the axis. We derive the format from
  // the series (the agent sets series[].format/currency/unit; the inline
  // editor writes the same fields) and resolve the currency as
  // series → workspace default. Gated on a format actually being
  // present so plain numeric axes (years, counts) are left untouched.
  const valueFormat = resolveValueFormat(out.series);
  const firstSeriesType = out.series?.[0]?.type;
  const isPieLike = firstSeriesType === "pie" || firstSeriesType === "donut";
  if (hasAxes && !isPieLike && hasValueFormat(valueFormat)) {
    // Axis ticks use compact abbreviation (£1.2M) to stay legible at
    // tick density; tooltips use full precision (£1,234,567).
    const axisFmt = makeValueFormatter(valueFormat, settings, { compact: true });
    const tipFmt = makeValueFormatter(valueFormat, settings, { compact: false });

    // The value axis is whichever axis ISN'T the category axis. Vertical
    // bar/line → x is category, y is value. Horizontal bar → swapped.
    const valueAxisKey: "xAxis" | "yAxis" = isCategoryAxis(
      out.xAxis as AxisLike | undefined
    )
      ? "yAxis"
      : isCategoryAxis(out.yAxis as AxisLike | undefined)
      ? "xAxis"
      : "yAxis";
    const valueAxis = out[valueAxisKey] as AxisLike | undefined;
    out[valueAxisKey] = {
      ...(valueAxis ?? {}),
      axisLabel: {
        ...((valueAxis?.axisLabel as Record<string, unknown> | undefined) ?? {}),
        formatter: axisFmt,
      },
    };

    // valueFormatter applies to axis-triggered tooltips without us
    // hand-building tooltip HTML. An explicit spec `formatter` (rare)
    // still wins — ECharts ignores valueFormatter when formatter is set.
    out.tooltip = {
      trigger: "axis",
      ...((out.tooltip as Record<string, unknown> | undefined) ?? {}),
      valueFormatter: tipFmt,
    };
  }

  return out;
}

interface ValueFormat {
  format?: "number" | "currency" | "percent";
  currency?: string;
  unit?: string;
}

/**
 * Pull the value-formatting hints off a chart's series. Prefers the
 * first series that declares a `format`, falling back to the first
 * series, so a chart whose KPI-style hints sit on series[0] still
 * resolves. Chart-level "full value format" edits write these fields
 * onto every series, so reading series[0] is sufficient there too.
 */
function resolveValueFormat(series: SeriesLike[] | undefined): ValueFormat {
  if (!series || series.length === 0) return {};
  const s = series.find((x) => x.format) ?? series[0];
  return { format: s.format, currency: s.currency, unit: s.unit };
}

function hasValueFormat(f: ValueFormat): boolean {
  return Boolean(f.format || f.currency || f.unit);
}

/**
 * Is this axis the CATEGORY axis (labels) rather than the VALUE axis
 * (the metric)? ECharts marks category axes with `type: "category"` or
 * by carrying a `data` array of labels. Used to decide which axis gets
 * the value formatter.
 */
function isCategoryAxis(axis: AxisLike | undefined): boolean {
  if (!axis) return false;
  if (axis.type === "category") return true;
  return Array.isArray(axis.data) && axis.data.length > 0;
}

/**
 * Build an ECharts label/value formatter for a resolved ValueFormat.
 *
 *   - currency → locale currency symbol + number (per-series currency
 *     overrides the workspace default)
 *   - percent  → shares the KPI fraction/percent heuristic
 *   - number   → token-formatted, optional unit suffix
 *
 * `compact` switches axis ticks to K/M/B abbreviation; tooltips pass
 * `compact: false` for full precision. Non-numeric values pass through
 * as strings so stray category values don't throw.
 */
function makeValueFormatter(
  fmt: ValueFormat,
  settings: WorkspaceSettings,
  opts: { compact: boolean }
): (value: unknown) => string {
  const num = (v: number) =>
    opts.compact
      ? abbreviateNumber(v, settings)
      : formatNumberWithToken(v, settings.numberFormat);
  return (value: unknown): string => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return value == null ? "" : String(value);
    }
    if (fmt.format === "percent") return formatPercentValue(value);
    if (fmt.format === "currency") {
      const symbol = currencySymbolFor(
        fmt.currency ?? settings.currency,
        settings.agentLocale
      );
      return `${symbol}${num(value)}`;
    }
    return fmt.unit ? `${num(value)}${fmt.unit}` : num(value);
  };
}

interface AxisLike {
  name?: string;
  nameLocation?: string;
  nameGap?: number;
  nameTextStyle?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Apply BI-grade title styling to an axis when it carries a `name`.
 *
 * - X-axis title sits centred below the axis (`nameLocation: middle`)
 *   with enough `nameGap` to clear the tick labels.
 * - Y-axis title sits centred along the axis; ECharts rotates it
 *   vertically automatically. A larger gap clears multi-digit value
 *   labels.
 *
 * Colour is intentionally left to the active ECharts theme so light /
 * dark both stay legible — we only set placement and weight. Axes
 * without a name pass through untouched (KPI/pie already strip axes
 * elsewhere; bar/line without a title just render as before).
 */
function styleAxisName(
  axis: AxisLike | undefined,
  which: "x" | "y"
): AxisLike | undefined {
  if (!axis || !axis.name) return axis;
  return {
    ...axis,
    nameLocation: axis.nameLocation ?? "middle",
    nameGap: axis.nameGap ?? (which === "x" ? 32 : 52),
    nameTextStyle: {
      fontWeight: 600,
      fontSize: 12,
      ...(axis.nameTextStyle ?? {}),
    },
  };
}

/**
 * Format an ISO-timestamp axis label per the workspace's dateFormat
 * token, in the workspace timezone. Honors the explicit token rather
 * than a locale convention so a user on `en-GB` who picks
 * "yyyy-mm-dd" sees ISO axes instead of "01/04". For full timestamps
 * (anything with a `T` component) we append HH:MM in 24-hour form so
 * the time component still survives the trim.
 *
 * Date-only strings don't get a timezone applied: they're DAY-level
 * values and any timezone shift would push the calendar day east/
 * west of UTC, which surprises users. Timestamp strings DO get the
 * customer's timezone so 00:00 UTC reads in their local zone.
 *
 * Bails out on non-strings or non-ISO values — anything that doesn't
 * match the strict regex passes through unchanged so non-time
 * category axes (product names, country codes, etc.) aren't touched.
 */
function formatIsoAxisLabel(value: unknown, settings: WorkspaceSettings): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    return String(value);
  }
  const isDateOnly = !value.includes("T");
  return formatDateWithToken(
    value,
    settings.dateFormat,
    // For date-only values, use UTC so the calendar day is preserved
    // regardless of the workspace timezone — otherwise an Asia/Tokyo
    // workspace would shift "2026-04-01" to "2026-04-02" at parse
    // time. The dateFormat helper passes this through to Intl as the
    // timezone arg.
    isDateOnly ? "UTC" : settings.timezone,
    { includeTime: !isDateOnly, locale: settings.agentLocale }
  );
}

/**
 * Translate a pie/donut chart spec into a properly-shaped ECharts
 * pie spec.
 *
 * Two things this fixes:
 *
 * 1. Our model contract puts categories in `xAxis.data` (strings)
 *    and values in `series[].data` (flat number array) — that
 *    matches bars/lines but ECharts pie/donut wants
 *    `data: [{name, value}, ...]` pairs. Without the pairing, pie
 *    segments render with just the index as label ("0", "1", "2")
 *    or, with our spec, the xAxis.data labels appear on the
 *    chart's axis area but the pie itself shows no values.
 *
 * 2. Pie/donut don't use xAxis or yAxis at all — leaving them in
 *    the spec produces a stray axis frame around the chart in
 *    ECharts. Strip both.
 *
 * Also installs a label formatter that shows the canonical
 * "name: value (percent%)" form so segments are self-explaining
 * instead of just colour-coded.
 *
 * Donut (`type: "donut"`) maps to pie with inner radius. Pie
 * (`type: "pie"`) stays a single-radius pie.
 */
function toPieOption(spec: ChartSpecLike): ChartSpecLike {
  const xLabels = (spec.xAxis as { data?: unknown[] } | undefined)?.data ?? [];
  return {
    ...spec,
    // Pie/donut don't use axes — drop them to avoid the stray frame.
    xAxis: undefined,
    yAxis: undefined,
    tooltip: spec.tooltip ?? { trigger: "item" },
    legend: spec.legend ?? { bottom: 0 },
    series: (spec.series ?? []).map((s) => {
      if (s.type !== "donut" && s.type !== "pie") return s;
      const flatData = Array.isArray(s.data) ? s.data : [];
      const paired = flatData.map((value, i) => ({
        name: typeof xLabels[i] === "string" ? (xLabels[i] as string) : `Item ${i + 1}`,
        value: typeof value === "number" ? value : 0,
      }));
      return {
        ...s,
        type: "pie",
        radius: s.type === "donut" ? ["40%", "70%"] : "65%",
        avoidLabelOverlap: true,
        data: paired,
        label: {
          formatter: "{b}: {c} ({d}%)",
        },
      };
    }),
  };
}
