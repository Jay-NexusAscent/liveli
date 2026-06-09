"use client";

import { useMemo } from "react";
import {
  DashboardIcon,
  ExpandIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
} from "@/components/icons";
import { ChartRenderer } from "@/components/chat/chart-renderer";
import type { WorkspaceSettings } from "@/lib/workspace-settings";

export interface GalleryDashboard {
  id: string;
  title: string;
  description?: string | null;
  favorite?: boolean;
  charts: Array<{ title: string; spec: unknown }>;
}

/**
 * Superset-style dashboard gallery: a searchable, favourite-sortable
 * grid of thumbnail cards the user scans before opening one. Each card
 * live-renders ALL of the dashboard's charts in a miniature grid so the
 * thumbnail reflects the whole dashboard, not just its first chart
 * (cheap for the current handful of dashboards; no snapshot pipeline).
 * Clicking the card opens the full dashboard; the star toggles a
 * favourite, which sorts to the front.
 */
export function DashboardGallery({
  dashboards,
  settings,
  query,
  onQueryChange,
  favouritesOnly,
  onFavouritesOnlyChange,
  onOpen,
  onToggleFavourite,
  onDelete,
  deleting,
}: {
  dashboards: GalleryDashboard[];
  settings?: WorkspaceSettings;
  query: string;
  onQueryChange: (q: string) => void;
  favouritesOnly: boolean;
  onFavouritesOnlyChange: (v: boolean) => void;
  onOpen: (id: string) => void;
  onToggleFavourite: (id: string, next: boolean) => void;
  onDelete: (id: string, title: string) => void;
  deleting: Set<string>;
}) {
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = dashboards.filter((d) => {
      if (favouritesOnly && !d.favorite) return false;
      if (!q) return true;
      return (
        d.title.toLowerCase().includes(q) ||
        (d.description ?? "").toLowerCase().includes(q)
      );
    });
    // Favourites first, otherwise preserve the incoming (createdAt-desc)
    // order. Stable sort keeps non-favourites in their original sequence.
    return [...matched].sort(
      (a, b) => Number(b.favorite ?? false) - Number(a.favorite ?? false)
    );
  }, [dashboards, query, favouritesOnly]);

  const favouriteCount = dashboards.filter((d) => d.favorite).length;

  return (
    <section className="mb-12">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
          Dashboards
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-1.5 text-text-tertiary focus-within:border-accent">
            <SearchIcon />
            <input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search dashboards…"
              className="w-44 bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => onFavouritesOnlyChange(!favouritesOnly)}
            aria-pressed={favouritesOnly}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
              favouritesOnly
                ? "border-accent bg-accent-muted text-accent"
                : "border-border bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary"
            }`}
          >
            <StarIcon filled={favouritesOnly} />
            Favourites
            {favouriteCount > 0 && (
              <span className="text-text-tertiary">{favouriteCount}</span>
            )}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-text-tertiary">
          {favouritesOnly
            ? "No favourited dashboards yet — tap the star on a dashboard to pin it here."
            : "No dashboards match your search."}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((d) => (
            <DashboardCard
              key={d.id}
              dashboard={d}
              settings={settings}
              onOpen={() => onOpen(d.id)}
              onToggleFavourite={() => onToggleFavourite(d.id, !d.favorite)}
              onDelete={() => onDelete(d.id, d.title)}
              deleting={deleting.has(d.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DashboardCard({
  dashboard,
  settings,
  onOpen,
  onToggleFavourite,
  onDelete,
  deleting,
}: {
  dashboard: GalleryDashboard;
  settings?: WorkspaceSettings;
  onOpen: () => void;
  onToggleFavourite: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const charts = dashboard.charts;
  const count = charts.length;
  // Mini-grid layout: ≤1 chart fills the tile, ≤4 go two-up, more go
  // three-up. Cell height is derived from the row count so the whole
  // grid fits the fixed ~134px preview area (150px tile minus p-2).
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellHeight = Math.max(38, Math.floor((134 - (rows - 1) * 4) / rows));

  return (
    <div className="card-elevated group relative flex flex-col overflow-hidden">
      {/* Live mini-render of every chart in a grid. pointer-events-none so
          the ECharts canvases don't swallow the click meant for opening
          the dashboard; the whole preview is a button. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open dashboard ${dashboard.title}`}
        className="block w-full border-b border-border bg-surface/40 text-left transition-colors hover:bg-hover/40"
      >
        <div className="pointer-events-none h-[150px] overflow-hidden p-2">
          {count > 0 ? (
            <div
              className="grid h-full gap-1"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {charts.map((c, i) => (
                <div key={i} className="overflow-hidden rounded-sm">
                  <ChartRenderer spec={c.spec} height={cellHeight} settings={settings} preview />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-text-tertiary">
              <DashboardIcon className="text-text-tertiary" />
            </div>
          )}
        </div>
      </button>

      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate text-[14px] font-semibold text-text-primary font-heading">
            {dashboard.title}
          </div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            {dashboard.charts.length}{" "}
            {dashboard.charts.length === 1 ? "chart" : "charts"}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onToggleFavourite}
            aria-label={
              dashboard.favorite
                ? `Unfavourite ${dashboard.title}`
                : `Favourite ${dashboard.title}`
            }
            aria-pressed={!!dashboard.favorite}
            className={`shrink-0 rounded-md p-1.5 transition-colors ${
              dashboard.favorite
                ? "text-accent hover:bg-hover"
                : "text-text-tertiary hover:bg-hover hover:text-text-primary"
            }`}
          >
            <StarIcon filled={!!dashboard.favorite} />
          </button>
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open dashboard ${dashboard.title}`}
            className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <ExpandIcon />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            aria-label={`Delete dashboard ${dashboard.title}`}
            className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
