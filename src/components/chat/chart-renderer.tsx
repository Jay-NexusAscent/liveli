"use client";

import dynamic from "next/dynamic";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceSettings,
} from "@/lib/workspace-settings";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

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
}: ChartRendererProps) {
  const chartSpec = (spec as ChartSpecLike) ?? {};
  const firstSeries = chartSpec.series?.[0];

  if (firstSeries?.type === "kpi") {
    return <KpiTile series={firstSeries} height={height} settings={settings} />;
  }

  // Apply universal polish to every non-KPI spec: smooth defaults on
  // line/area series + ISO-timestamp formatting on category-axis
  // labels. Donut translation runs after so it operates on a spec
  // that already has the polish baked in.
  const polished = polishChartSpec(chartSpec, settings);
  const firstType = polished.series?.[0]?.type;
  const echartsOption =
    firstType === "donut" || firstType === "pie"
      ? toPieOption(polished)
      : polished;

  const isLightTheme =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";

  return (
    <ReactECharts
      option={echartsOption as object}
      style={{ height, width: "100%" }}
      theme={isLightTheme ? "default" : "dark"}
      opts={{ renderer: "svg" }}
    />
  );
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
}: {
  series: SeriesLike;
  height: number;
  settings: WorkspaceSettings;
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
      ? `${(series.delta as number) > 0 ? "+" : ""}${abbreviateNumber(series.delta as number)}`
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
        className="w-full max-w-full truncate text-[36px] font-semibold tracking-tight text-text-primary font-heading tabular-nums leading-none"
        // title attribute exposes the full unformatted number for
        // accessibility / user hover-to-verify use cases. Locale-aware
        // so users in en-US / en-IN etc. see their expected separators.
        title={value.toLocaleString(settings.agentLocale)}
      >
        {formatted}
      </div>
      {series.name && (
        <div className="mt-2 max-w-full truncate text-[13px] text-text-secondary">
          {series.name}
        </div>
      )}
      {hasDelta && deltaFormatted && (
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
 */
function abbreviateNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 100_000) return `${Math.round(n / 1_000).toLocaleString()}K`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
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
    // Resolve currency: per-series override (e.g. connector-reported)
    // takes precedence, then workspace setting. Use the locale's
    // currency symbol via Intl, so a USD KPI on an en-GB workspace
    // shows "US$1.2M" rather than the bare prefix.
    const currency = currencyOverride ?? settings.currency;
    const abbreviated = abbreviateNumber(value);
    let symbol = currency; // safe fallback
    try {
      // Render a tiny value purely to extract the currency symbol the
      // locale would use, then prefix our already-abbreviated number.
      // Doing it this way keeps the K / M / B abbreviation logic shared
      // with the non-currency code path.
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
  const abbreviated = abbreviateNumber(value);
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

  // 1. Smooth-line defaults
  if (Array.isArray(out.series)) {
    out.series = out.series.map((s) => {
      const isLineish = s.type === "line" || s.type === "area";
      if (isLineish && (s as { smooth?: unknown }).smooth === undefined) {
        return { ...s, smooth: true };
      }
      return s;
    });
  }

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

  return out;
}

/**
 * Compact axis-label format for ISO-timestamp categories. Drops the
 * year (most time-series live inside a single year and the tooltip
 * still carries full context); drops seconds and milliseconds (noise
 * at chart-axis granularity). Locale-aware so users get their natural
 * month-name conventions ("Apr" en-US vs "Apr" en-GB happen to match,
 * but other locales differ).
 *
 * Bails out on non-strings or non-ISO values — anything that doesn't
 * match the strict regex passes through unchanged so non-time
 * category axes (product names, country codes, etc.) aren't touched.
 */
function formatIsoAxisLabel(value: unknown, settings: WorkspaceSettings): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    return String(value);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  // Date-only string → just show "Apr 1"; full timestamp → "Apr 1, 00:00".
  const isDateOnly = !value.includes("T");
  return new Intl.DateTimeFormat(
    settings.agentLocale,
    isDateOnly
      ? { month: "short", day: "numeric" }
      : {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          // Date-only labels don't need a timezone — they're DAY-level
          // and timezone conversion would shift them by a calendar day
          // for users east/west of UTC. Timestamp labels get the
          // customer's timezone applied so 00:00 UTC reads correctly.
          timeZone: settings.timezone,
        }
  ).format(d);
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
