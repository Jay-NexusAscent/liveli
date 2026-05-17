import { DashboardIcon, SparkleIcon } from "@/components/icons";

export default function DashboardsPage() {
  return (
    <div className="container-page py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">Dashboards</h1>
          <p className="mt-1 text-[14px] text-text-secondary">
            Save charts from chat or describe a dashboard in plain English — Liveli builds it.
          </p>
        </div>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-text-inverted opacity-60"
        >
          <SparkleIcon className="text-text-inverted" />
          New dashboard
        </button>
      </header>

      <div className="card-elevated flex flex-col items-center justify-center gap-3 py-20 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-muted text-accent">
          <DashboardIcon className="text-accent" />
        </div>
        <h2 className="text-[18px] font-semibold tracking-tight text-text-primary font-heading">No dashboards yet</h2>
        <p className="max-w-md text-[14px] text-text-secondary">
          Once the agent is wired, pin any chart from a chat conversation to spin up your first
          dashboard — or describe what you want and Liveli will build it.
        </p>
      </div>
    </div>
  );
}
