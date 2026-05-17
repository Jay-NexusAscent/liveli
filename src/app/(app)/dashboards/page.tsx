"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { DashboardIcon, SparkleIcon } from "@/components/icons";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface SavedChart {
  id: string;
  title: string;
  spec: unknown;
  createdAt?: { _seconds: number };
}

interface SavedDashboard {
  id: string;
  title: string;
  description?: string | null;
  charts: Array<{ order: number; title: string; spec: unknown }>;
}

export default function DashboardsPage() {
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [dashboards, setDashboards] = useState<SavedDashboard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [chartsRes, dashRes] = await Promise.all([
          fetch("/api/charts"),
          fetch("/api/dashboards"),
        ]);
        if (chartsRes.ok) setCharts((await chartsRes.json()).items ?? []);
        if (dashRes.ok) setDashboards((await dashRes.json()).items ?? []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const isEmpty = !loading && charts.length === 0 && dashboards.length === 0;

  return (
    <div className="container-page py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">
            Dashboards
          </h1>
          <p className="mt-1 text-[14px] text-text-secondary">
            Charts you&apos;ve saved from chat, plus dashboards the agent has composed.
          </p>
        </div>
      </header>

      {loading && <p className="text-[13px] text-text-tertiary">Loading…</p>}

      {isEmpty && (
        <div className="card-elevated flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-muted text-accent">
            <DashboardIcon className="text-accent" />
          </div>
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary font-heading">
            Nothing here yet
          </h2>
          <p className="max-w-md text-[14px] text-text-secondary">
            Open the Chat tab, ask a question, and click &ldquo;Save to dashboard&rdquo;
            on any chart — or ask the agent to &ldquo;build a sales overview
            dashboard&rdquo;.
          </p>
        </div>
      )}

      {dashboards.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-4 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
            <SparkleIcon /> Agent-composed dashboards
          </h2>
          <div className="space-y-8">
            {dashboards.map((d) => (
              <div key={d.id} className="card-elevated p-6">
                <div className="mb-4">
                  <h3 className="text-[18px] font-semibold text-text-primary font-heading">
                    {d.title}
                  </h3>
                  {d.description && (
                    <p className="mt-1 text-[13px] text-text-secondary">{d.description}</p>
                  )}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {d.charts.map((c, i) => (
                    <ChartTile key={i} title={c.title} spec={c.spec} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {charts.length > 0 && (
        <section>
          <h2 className="mb-4 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
            Saved charts
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {charts.map((c) => (
              <ChartTile key={c.id} title={c.title} spec={c.spec} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ChartTile({ title, spec }: { title: string; spec: unknown }) {
  return (
    <div className="card-elevated overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 text-[13px] font-medium text-text-primary">
        {title}
      </div>
      <div className="p-3">
        <ReactECharts
          option={spec as object}
          style={{ height: 260, width: "100%" }}
          opts={{ renderer: "svg" }}
        />
      </div>
    </div>
  );
}
