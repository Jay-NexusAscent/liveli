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

  const echartsOption = firstSeries?.type === "donut"
    ? toDonutOption(chartSpec)
    : chartSpec;

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
 * Render a KPI tile: large headline number, optional unit/format,
 * optional delta with up/down arrow + caption. Theme-token aware.
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
      ? `${(series.delta as number) > 0 ? "+" : ""}${(series.delta as number).toLocaleString()}`
      : null;

  return (
    <div
      className="flex w-full flex-col items-start justify-center"
      style={{ minHeight: height }}
    >
      <div className="text-[44px] font-semibold tracking-tight text-text-primary font-heading tabular-nums leading-none">
        {formatted}
      </div>
      {series.name && (
        <div className="mt-2 text-[13px] text-text-secondary">{series.name}</div>
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

function formatKpiValue(
  value: number,
  format?: "number" | "currency" | "percent",
  unit?: string
): string {
  if (format === "percent") {
    return `${value.toFixed(1)}%`;
  }
  if (format === "currency") {
    return `£${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  const base = value.toLocaleString();
  return unit ? `${base}${unit}` : base;
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
