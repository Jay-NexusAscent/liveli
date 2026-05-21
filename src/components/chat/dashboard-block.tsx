"use client";

import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { ChartRenderer } from "./chart-renderer";

interface DashboardBlockProps {
  title: string;
  description?: string;
  dashboardId: string;
  charts: Array<{ order: number; title: string; spec: unknown }>;
}

/**
 * Inline dashboard preview rendered in chat after `make_dashboard`
 * succeeds. Shows every chart in the dashboard at a smaller height so
 * the user sees the actual result, not just a confirmation.
 *
 * The full dashboard with edit affordances lives at /dashboards — we
 * link there from the header. Each individual chart shown here also
 * exists on the Dashboards page; this block is read-only on purpose.
 */
export function DashboardBlock({ title, description, dashboardId, charts }: DashboardBlockProps) {
  const sortedCharts = [...charts].sort((a, b) => a.order - b.order);

  return (
    <div className="card-elevated my-3 overflow-hidden" data-dashboard-id={dashboardId}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[14px] font-semibold tracking-tight text-text-primary font-heading">
            {title}
          </div>
          {description && (
            <div className="mt-0.5 text-[12px] text-text-secondary">{description}</div>
          )}
        </div>
        <Link
          href={`/dashboards#${dashboardId}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-accent transition-colors hover:bg-accent hover:text-white"
        >
          Open
          <ArrowRightIcon className="h-3 w-3" />
        </Link>
      </div>
      <div className="grid gap-3 p-3 md:grid-cols-2">
        {sortedCharts.map((chart, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-background/40 p-3"
          >
            <div className="mb-2 text-[12px] font-medium text-text-secondary">
              {chart.title}
            </div>
            <ChartRenderer spec={chart.spec} height={220} />
          </div>
        ))}
      </div>
    </div>
  );
}
