"use client";

import Link from "next/link";
import { ArrowRightIcon, DashboardIcon } from "@/components/icons";
import { ChartRenderer } from "./chart-renderer";

import type { ColSpan } from "@/lib/dashboards/types";

interface DashboardChart {
  order: number;
  title: string;
  spec: unknown;
  colSpan?: ColSpan;
}

interface DashboardBlockProps {
  title: string;
  description?: string;
  dashboardId: string;
  charts: DashboardChart[];
}

/**
 * Inline dashboard preview rendered in chat after `make_dashboard`
 * succeeds. Hybrid preview shape (Option C in the audit feedback):
 *
 *   - **KPI strip only** — the small headline-number tiles render
 *     inline at full readable size in a 2-column grid that fits
 *     comfortably within the chat's centred max-width
 *   - **Summary row** — counts the non-KPI charts ("Plus 3 charts:
 *     monthly revenue, top products, channels"), no inline render
 *   - **Prominent Open CTA** — bigger button, full-width on its row,
 *     to push the customer to /dashboards for the full layout
 *
 * Why hybrid: the previous full-content preview suffered from chat
 * width squashing the time-series + bar + pie charts, with KPI
 * numbers being truncated mid-string (e.g. "£187..." instead of
 * "£187.56") and labels overlapping. Time-series charts especially
 * are unreadable at chat width. KPIs are the one chart type that
 * genuinely fits — they're a single number per tile and the
 * abbreviation logic already handles narrow widths.
 *
 * The full multi-chart layout lives where it can breathe:
 * /dashboards (full-width grid, proper sizing per colSpan).
 *
 * A chart's KPI status is determined by inspecting its spec's
 * `series[0].type` for "kpi" — same dispatch logic as
 * ChartRenderer uses.
 */
function isKpiChart(chart: DashboardChart): boolean {
  const spec = chart.spec as
    | { series?: Array<{ type?: string }> }
    | undefined
    | null;
  return spec?.series?.[0]?.type === "kpi";
}

export function DashboardBlock({ title, description, dashboardId, charts }: DashboardBlockProps) {
  const sortedCharts = [...charts].sort((a, b) => a.order - b.order);
  const kpiCharts = sortedCharts.filter(isKpiChart);
  const otherCharts = sortedCharts.filter((c) => !isKpiChart(c));

  return (
    <div className="card-elevated my-3 overflow-hidden" data-dashboard-id={dashboardId}>
      {/* Header — title + description */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-text-secondary">
          <DashboardIcon className="h-4 w-4" />
          <span className="text-[11px] font-medium uppercase tracking-wider">Dashboard</span>
        </div>
        <div className="mt-1 text-[15px] font-semibold tracking-tight text-text-primary font-heading">
          {title}
        </div>
        {description && (
          <div className="mt-0.5 text-[12px] text-text-secondary">{description}</div>
        )}
      </div>

      {/* KPI strip — only KPI tiles render inline. 2-column grid fits
          chat width comfortably without truncation. */}
      {kpiCharts.length > 0 && (
        <div className="grid gap-3 border-b border-border p-3 sm:grid-cols-2">
          {kpiCharts.map((chart, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background/40 p-3"
            >
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                {chart.title}
              </div>
              <ChartRenderer spec={chart.spec} height={90} />
            </div>
          ))}
        </div>
      )}

      {/* Non-KPI summary — list the chart titles, no inline render.
          Customer clicks Open to see them at full size. */}
      {otherCharts.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
            Plus {otherCharts.length} {otherCharts.length === 1 ? "chart" : "charts"} in dashboard
          </div>
          <ul className="mt-2 space-y-1">
            {otherCharts.map((chart, i) => (
              <li
                key={i}
                className="flex items-baseline gap-2 text-[13px] text-text-secondary"
              >
                <span className="text-text-tertiary">•</span>
                <span>{chart.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Prominent Open CTA — full-width, taller than the previous
          inline pill so it reads as the obvious next action. */}
      <div className="p-3">
        <Link
          href={`/dashboards#${dashboardId}`}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent-muted px-4 py-2.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent hover:text-text-inverted"
        >
          Open dashboard
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
