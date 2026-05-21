"use client";

import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface SeriesLike {
  type?: string;
  data?: unknown[];
  name?: string;
  format?: "number" | "currency" | "percent";
  unit?: string;
  delta?: number;
  deltaLabel?: string;
}

interface ChartSpecLike {
  series?: SeriesLike[];
  // Other ECharts fields are passed straight through.
  [k: string]: unknown;
}

interface ChartRendererProps {
  spec: unknown;
  height?: number;
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
export function ChartRenderer({ spec, height = 320 }: ChartRendererProps) {
  const chartSpec = (spec as ChartSpecLike) ?? {};
  const firstSeries = chartSpec.series?.[0];

  if (firstSeries?.type === "kpi") {
    return <KpiTile series={firstSeries} height={height} />;
  }

  // Apply universal polish to every non-KPI spec: smooth defaults on
  // line/area series + ISO-timestamp formatting on category-axis
  // labels. Donut translation runs after so it operates on a spec
  // that already has the polish baked in.
  const polished = polishChartSpec(chartSpec);
  const echartsOption = polished.series?.[0]?.type === "donut"
    ? toDonutOption(polished)
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
function KpiTile({ series, height }: { series: SeriesLike; height: number }) {
  const value = typeof series.data?.[0] === "number" ? (series.data[0] as number) : 0;
  const formatted = formatKpiValue(value, series.format, series.unit);
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
        // accessibility / user hover-to-verify use cases.
        title={value.toLocaleString()}
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
  format?: "number" | "currency" | "percent",
  unit?: string
): string {
  if (format === "percent") {
    return `${value.toFixed(1)}%`;
  }
  const abbreviated = abbreviateNumber(value);
  if (format === "currency") {
    return `£${abbreviated}`;
  }
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
function polishChartSpec(spec: ChartSpecLike): ChartSpecLike {
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

  // 2. ISO-timestamp axis labels
  const xAxis = out.xAxis as
    | { type?: string; data?: unknown[]; axisLabel?: Record<string, unknown> }
    | undefined;
  if (xAxis && Array.isArray(xAxis.data)) {
    const hasIsoData = xAxis.data.some(
      (v) => typeof v === "string" && ISO_DATE_RE.test(v)
    );
    if (hasIsoData) {
      out.xAxis = {
        ...xAxis,
        axisLabel: {
          ...(xAxis.axisLabel ?? {}),
          formatter: formatIsoAxisLabel,
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
function formatIsoAxisLabel(value: unknown): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    return String(value);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  // Date-only string → just show "Apr 1"; full timestamp → "Apr 1, 00:00".
  const isDateOnly = !value.includes("T");
  return new Intl.DateTimeFormat(
    undefined,
    isDateOnly
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(d);
}

/**
 * Translate a donut chart spec into an ECharts pie with an inner
 * radius. The model emits type: "donut" via the SeriesSchema enum;
 * ECharts itself doesn't have a "donut" type — it's a pie with
 * `radius: [innerR, outerR]`. We do the translation here so the
 * model's contract stays clean.
 */
function toDonutOption(spec: ChartSpecLike): ChartSpecLike {
  return {
    ...spec,
    series: (spec.series ?? []).map((s) =>
      s.type === "donut"
        ? {
            ...s,
            type: "pie",
            radius: ["40%", "70%"],
            avoidLabelOverlap: true,
          }
        : s
    ),
  };
}
