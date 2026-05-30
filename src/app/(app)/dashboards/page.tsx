"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  DashboardIcon,
  ExpandIcon,
  GripIcon,
  PencilIcon,
  SparkleIcon,
  TrashIcon,
} from "@/components/icons";
import { FullscreenModal } from "@/components/dashboards/fullscreen-modal";
import { FilterBar } from "@/components/dashboards/filter-bar";
import { ChartRenderer } from "@/components/chat/chart-renderer";
import { EmptyState } from "@/components/ui/empty-state";
import { defaultFilterValues } from "@/lib/dashboards/filter-defaults";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceSettings,
} from "@/lib/workspace-settings";
import type {
  ChartDataMapping,
  ColSpan,
  FilterDef,
  FilterValues,
} from "@/lib/dashboards/types";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const DEFAULT_COL_SPAN: ColSpan = "medium";

/**
 * Map a ColSpan to the explicit Tailwind utility classes used on the
 * dashboard 4-col grid. Written out as full literal strings so
 * Tailwind's content-detection picks them up — never compose class
 * names dynamically with concatenation (JIT will miss them).
 *
 * Each "block unit" is `md:auto-rows-[180px]` tall on the grid
 * container. Small / Medium / Large span 2 row units (≈376px with
 * the gap) which is comfortable for bar / line / pie charts.
 * Extra small spans only 1 row unit (180px) — designed for single-
 * value KPI cards where a full-height tile is wasted real estate.
 */
const COL_SPAN_CLASSES: Record<ColSpan, string> = {
  "extra-small": "md:col-span-1 md:row-span-1",
  small: "md:col-span-1 md:row-span-2",
  medium: "md:col-span-2 md:row-span-2",
  large: "md:col-span-4 md:row-span-2",
};

const COL_SPAN_LABELS: Record<ColSpan, string> = {
  "extra-small": "Extra small",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

const COL_SPAN_BUTTON_LABELS: Record<ColSpan, string> = {
  "extra-small": "XS",
  small: "S",
  medium: "M",
  large: "L",
};

interface SavedChart {
  id: string;
  title: string;
  spec: unknown;
  createdAt?: { _seconds: number };
}

/**
 * Client-side shape for a chart inside a dashboard.
 *
 * `_localId` is generated when the dashboards endpoint response is
 * hydrated into state — the API doesn't ship per-chart IDs (the chart
 * array is stored inline on the dashboard Firestore doc, so there's
 * no per-row identifier). dnd-kit's SortableContext needs stable
 * string IDs that survive reorders, so we mint client-side UUIDs at
 * load time and use them as the React key AND the sortable id.
 *
 * `_localId` never leaves the client — the helpers below strip it
 * before sending charts back to the API or into the edit-via-chat
 * sessionStorage payload.
 */
interface DashboardChart {
  order: number;
  title: string;
  spec: unknown;
  colSpan?: ColSpan;
  // ─── filter-driven re-render (LIVELI-122 Phase 2/3) ────────────────
  // Round-tripped through reads/writes so reorder/resize don't downgrade
  // a chart to static. Both must be present for /render to refresh it.
  sourceSql?: string;
  dataMapping?: ChartDataMapping;
  // Populated when the most recent /render call returned a chart-level
  // error for this chart. The render endpoint preserves the saved spec
  // on error, so the visual content is the previous render's output —
  // this field lets the UI tell the user the displayed numbers are
  // stale relative to the current filter values. Cleared on the next
  // successful render for this chart.
  _renderError?: string;
  _localId: string;
}

interface SavedDashboard {
  id: string;
  title: string;
  description?: string | null;
  charts: DashboardChart[];
  /** Optional dashboard-wide filters (Phase 2). Empty/missing → no filter bar. */
  filters?: FilterDef[];
}

type FullscreenContent =
  | { kind: "chart"; id: string; title: string; spec: unknown }
  | {
      kind: "dashboard";
      id: string;
      title: string;
      description?: string | null;
      charts: Array<{ order: number; title: string; spec: unknown; colSpan?: ColSpan }>;
    };

/**
 * Drop the client-only `_localId` field before sending charts to the
 * API or into the edit-via-chat sessionStorage payload. Keeps the
 * server contract clean and avoids leaking a meaningless UUID into
 * the LLM's edit-mode preamble. Preserves `colSpan` so the API /
 * agent see the user's sizing choices.
 */
function stripLocalIds(
  charts: DashboardChart[]
): Array<{
  order: number;
  title: string;
  spec: unknown;
  colSpan?: ColSpan;
  sourceSql?: string;
  dataMapping?: ChartDataMapping;
}> {
  return charts.map((c) => ({
    order: c.order,
    title: c.title,
    spec: c.spec,
    ...(c.colSpan ? { colSpan: c.colSpan } : {}),
    // Pass through filter-driven fields. Without these, a reorder /
    // resize PATCH would silently strip them server-side and break
    // future /render calls. The PATCH endpoint round-trips both.
    ...(c.sourceSql ? { sourceSql: c.sourceSql } : {}),
    ...(c.dataMapping ? { dataMapping: c.dataMapping } : {}),
  }));
}

// ─── localStorage helpers ────────────────────────────────────────────
//
// Filter selections are persisted per-browser, per-dashboard.
// Cross-device sync is deferred (the LIVELI-122 Phase 1 design
// decision); when we hit that pain we'll lift this to Firestore.

const FILTER_LS_PREFIX = "liveli.dashboard-filters.";

function filterStorageKey(dashboardId: string): string {
  return `${FILTER_LS_PREFIX}${dashboardId}`;
}

function loadFilterValues(dashboardId: string): FilterValues | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(filterStorageKey(dashboardId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FilterValues;
    }
    return null;
  } catch {
    // Malformed JSON in storage shouldn't crash the page — fall back
    // to defaults rather than throwing.
    return null;
  }
}

function saveFilterValues(dashboardId: string, values: FilterValues): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(filterStorageKey(dashboardId), JSON.stringify(values));
  } catch {
    // Storage quota / private-mode failures — silent. The current
    // session keeps working; only persistence across reloads is lost.
  }
}

export default function DashboardsPage() {
  const router = useRouter();
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [dashboards, setDashboards] = useState<SavedDashboard[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-id pending state for delete actions — prevents double-clicks
  // and lets the trash icon dim while the DELETE round-trips.
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  // Currently-fullscreened chart or dashboard, or null. Single piece of
  // state so only one fullscreen view can be open at a time.
  const [fullscreen, setFullscreen] = useState<FullscreenContent | null>(null);
  // Workspace regional preferences — drives currency / locale /
  // timezone in every chart on this page (inline tiles + fullscreen
  // overlay). Defaults render the first paint; the GET below replaces
  // them with the customer's saved values once the workspace doc loads.
  const [settings, setSettings] = useState<WorkspaceSettings>(
    DEFAULT_WORKSPACE_SETTINGS
  );

  // ─── filter state per dashboard ───────────────────────────────────
  //
  // Keyed by dashboard id. Populated during the dashboards-load
  // useEffect from localStorage (or filter defaults when no saved
  // state). Mutated when the user picks a value in the FilterBar.
  const [filterValuesByDashboard, setFilterValuesByDashboard] = useState<
    Record<string, FilterValues>
  >({});
  // Dashboards currently fetching /render — drives the "Updating…"
  // indicator on each filter bar.
  const [renderingByDashboard, setRenderingByDashboard] = useState<Set<string>>(
    new Set()
  );
  // Per-dashboard sequence counter for stale-response handling. If the
  // user changes filter A then quickly changes filter B before A's
  // /render response lands, B's request bumps the seq — when A's
  // response finally arrives, we see its seq < latest and discard.
  // Kept in a ref because it's purely client-side coordination and
  // doesn't need to trigger re-renders.
  const renderSeqRef = useRef<Record<string, number>>({});

  // dnd-kit sensors. PointerSensor with a small activation distance
  // so clicking the grip without dragging doesn't immediately start a
  // drag (and obscure subsequent click handlers on the tile). The
  // KeyboardSensor lets keyboard-only users reorder: Tab to the grip,
  // Space to grab, arrows to move, Space to drop.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  /**
   * Stash the chart or dashboard in sessionStorage and navigate to the
   * chat surface. ChatWindow reads `liveli.editing` on mount, shows the
   * Editing X banner, and forwards the context to /api/chat so the
   * agent uses update_chart / update_dashboard with this id.
   */
  const openEditInChat = (
    payload:
      | { kind: "chart"; id: string; title: string; spec: unknown }
      | {
          kind: "dashboard";
          id: string;
          title: string;
          description?: string | null;
          charts: Array<{ order: number; title: string; spec: unknown }>;
        }
  ) => {
    sessionStorage.setItem("liveli.editing", JSON.stringify(payload));
    router.push("/chat");
  };

  useEffect(() => {
    (async () => {
      try {
        const [chartsRes, dashRes, settingsRes] = await Promise.all([
          fetch("/api/charts"),
          fetch("/api/dashboards"),
          fetch("/api/workspaces/settings"),
        ]);
        if (settingsRes.ok) {
          try {
            const json = (await settingsRes.json()) as {
              settings?: WorkspaceSettings;
            };
            if (json.settings) setSettings(json.settings);
          } catch {
            // ignore — chart renderers fall back to defaults
          }
        }
        if (chartsRes.ok) setCharts((await chartsRes.json()).items ?? []);
        if (dashRes.ok) {
          // Hydrate the server-side dashboards with stable client-side
          // ids on each chart so dnd-kit's SortableContext has IDs
          // that survive reordering.
          type ServerChart = {
            order: number;
            title: string;
            spec: unknown;
            colSpan?: ColSpan;
            sourceSql?: string;
            dataMapping?: ChartDataMapping;
          };
          type ServerDashboard = Omit<SavedDashboard, "charts"> & { charts: ServerChart[] };
          const items: ServerDashboard[] = (await dashRes.json()).items ?? [];
          setDashboards(
            items.map((d) => ({
              ...d,
              charts: d.charts.map((c) => ({ ...c, _localId: crypto.randomUUID() })),
            }))
          );
          // Seed filter values per dashboard: prefer the user's
          // localStorage selections; fall back to the dashboard's
          // authored defaults if no saved state exists.
          const seededValues: Record<string, FilterValues> = {};
          for (const d of items) {
            if (!d.filters || d.filters.length === 0) continue;
            const stored = loadFilterValues(d.id);
            seededValues[d.id] = stored ?? defaultFilterValues(d.filters);
          }
          setFilterValuesByDashboard(seededValues);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const deleteChart = async (id: string, title: string) => {
    if (!confirm(`Delete chart "${title}"? This can't be undone.`)) return;
    setDeleting((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/charts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCharts((cs) => cs.filter((c) => c.id !== id));
    } catch (err) {
      alert(`Failed to delete chart: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const deleteDashboard = async (id: string, title: string) => {
    if (!confirm(`Delete dashboard "${title}" and all its charts? This can't be undone.`)) return;
    setDeleting((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/dashboards/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDashboards((ds) => ds.filter((d) => d.id !== id));
    } catch (err) {
      alert(`Failed to delete dashboard: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  /**
   * Persist a chart reorder. Optimistically updates local state so the
   * grid moves immediately, then fires a PATCH with the full charts
   * array (replacement semantics — the API normalises `order` from
   * array index). On failure, rolls back to the previous order.
   *
   * Race note: if a second reorder lands before the first PATCH
   * resolves, the optimistic state is already at the latest order
   * either way — the second reorder builds on the first's local
   * state, not the server's. The PATCH itself just overwrites the
   * server doc, so the final server state matches whatever the
   * latest client state was. Good enough for single-user dashboards.
   */
  const reorderDashboardCharts = async (
    dashboardId: string,
    fromLocalId: string,
    toLocalId: string
  ) => {
    let previousDashboards: SavedDashboard[] = [];
    let nextDashboard: SavedDashboard | undefined;
    setDashboards((ds) => {
      previousDashboards = ds;
      return ds.map((d) => {
        if (d.id !== dashboardId) return d;
        const oldIdx = d.charts.findIndex((c) => c._localId === fromLocalId);
        const newIdx = d.charts.findIndex((c) => c._localId === toLocalId);
        if (oldIdx < 0 || newIdx < 0 || oldIdx === newIdx) return d;
        const moved = arrayMove(d.charts, oldIdx, newIdx).map((c, i) => ({
          ...c,
          order: i,
        }));
        const updated = { ...d, charts: moved };
        nextDashboard = updated;
        return updated;
      });
    });
    if (!nextDashboard) return;
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charts: stripLocalIds(nextDashboard.charts) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setDashboards(previousDashboards);
      alert(
        `Couldn't save the new order: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  /**
   * Persist a chart size change. Same optimistic + PATCH + rollback
   * pattern as reorderDashboardCharts. Sending the full charts array
   * is wasteful for a single-field change but the PATCH endpoint uses
   * replacement semantics, so it's the only option without adding a
   * dedicated sub-route. Network cost is tiny anyway (the spec is
   * already cached on the server).
   */
  const resizeDashboardChart = async (
    dashboardId: string,
    chartLocalId: string,
    newSize: ColSpan
  ) => {
    let previousDashboards: SavedDashboard[] = [];
    let nextDashboard: SavedDashboard | undefined;
    setDashboards((ds) => {
      previousDashboards = ds;
      return ds.map((d) => {
        if (d.id !== dashboardId) return d;
        const idx = d.charts.findIndex((c) => c._localId === chartLocalId);
        if (idx < 0) return d;
        if (d.charts[idx].colSpan === newSize) return d;
        const charts = d.charts.map((c, i) =>
          i === idx ? { ...c, colSpan: newSize } : c
        );
        const updated = { ...d, charts };
        nextDashboard = updated;
        return updated;
      });
    });
    if (!nextDashboard) return;
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charts: stripLocalIds(nextDashboard.charts) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setDashboards(previousDashboards);
      alert(
        `Couldn't save the new size: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  /**
   * Re-render a dashboard's filter-driven charts under a new set of
   * filter values. Posts to /api/dashboards/<id>/render, then merges
   * the rebuilt specs back into local state.
   *
   * Stale-response handling: each call increments
   * renderSeqRef[dashboardId] before firing. The response is only
   * applied if its seq is still the latest — otherwise a stale
   * response would clobber a more recent change.
   *
   * Per-chart errors are surfaced via `_renderError` on the chart;
   * the displayed spec remains the previously rendered one (the
   * server returns the original spec untouched on chart error).
   */
  const runRender = async (dashboardId: string, values: FilterValues) => {
    const nextSeq = (renderSeqRef.current[dashboardId] ?? 0) + 1;
    renderSeqRef.current[dashboardId] = nextSeq;
    setRenderingByDashboard((s) => {
      const next = new Set(s);
      next.add(dashboardId);
      return next;
    });
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filterValues: values }),
      });
      if (renderSeqRef.current[dashboardId] !== nextSeq) {
        // A newer render landed (or is in-flight) — discard this stale
        // response without touching state. The newer call's response
        // will paint the canonical result.
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error ?? `HTTP ${res.status}`;
        console.warn("[dashboard render] failed", dashboardId, msg);
        return;
      }
      const payload = (await res.json()) as {
        charts: Array<{
          order: number;
          title: string;
          spec: unknown;
          colSpan?: ColSpan;
          sourceSql?: string;
          dataMapping?: ChartDataMapping;
          error?: string;
        }>;
      };
      // Merge: match server charts to local charts by order index.
      // Both sides preserve order, so a positional zip is safe. We
      // keep `_localId` (dnd-kit key) + `sourceSql` + `dataMapping`
      // from local state, and take the freshly rebuilt `spec` (and
      // any per-chart error) from the server.
      setDashboards((ds) =>
        ds.map((d) => {
          if (d.id !== dashboardId) return d;
          const byOrder = new Map<number, (typeof payload.charts)[number]>();
          for (const sc of payload.charts) byOrder.set(sc.order, sc);
          const charts = d.charts.map((c) => {
            const sc = byOrder.get(c.order);
            if (!sc) return { ...c, _renderError: undefined };
            return {
              ...c,
              spec: sc.spec,
              _renderError: sc.error,
            };
          });
          return { ...d, charts };
        })
      );
    } finally {
      // Only clear "updating" if our seq is still the latest. If a
      // newer call has already bumped seq, leave the indicator on —
      // that newer call's finally block will turn it off.
      if (renderSeqRef.current[dashboardId] === nextSeq) {
        setRenderingByDashboard((s) => {
          const next = new Set(s);
          next.delete(dashboardId);
          return next;
        });
      }
    }
  };

  /**
   * Filter-bar change handler. Updates local state, writes
   * localStorage immediately so a refresh preserves the selection,
   * then kicks off /render. Async/awaitless on purpose — the UI
   * spinner-state is driven by `renderingByDashboard`, not by the
   * promise returned here.
   */
  const handleFilterChange = (dashboardId: string, next: FilterValues) => {
    setFilterValuesByDashboard((m) => ({ ...m, [dashboardId]: next }));
    saveFilterValues(dashboardId, next);
    void runRender(dashboardId, next);
  };

  /**
   * Reset a dashboard's filters back to authored defaults. Clears the
   * localStorage entry so a future load also starts at defaults, then
   * re-renders.
   */
  const resetFilters = (dashboardId: string, filters: FilterDef[]) => {
    const next = defaultFilterValues(filters);
    setFilterValuesByDashboard((m) => ({ ...m, [dashboardId]: next }));
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(filterStorageKey(dashboardId));
    }
    void runRender(dashboardId, next);
  };

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
        <EmptyState
          icon={<DashboardIcon className="text-accent" />}
          title="Nothing here yet"
          description={
            <>
              Open the Chat tab, ask a question, and click &ldquo;Save to
              dashboard&rdquo; on any chart — or ask the agent to &ldquo;build
              a sales overview dashboard&rdquo;.
            </>
          }
        />
      )}

      {dashboards.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-4 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
            <SparkleIcon /> Agent-composed dashboards
          </h2>
          <div className="space-y-8">
            {dashboards.map((d) => (
              <div key={d.id} className="card-elevated p-6">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-[18px] font-semibold text-text-primary font-heading">
                      {d.title}
                    </h3>
                    {d.description && (
                      <p className="mt-1 text-[13px] text-text-secondary">{d.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton
                      onClick={() =>
                        openEditInChat({
                          kind: "dashboard",
                          id: d.id,
                          title: d.title,
                          description: d.description,
                          charts: stripLocalIds(d.charts),
                        })
                      }
                      ariaLabel={`Edit dashboard ${d.title}`}
                      variant="neutral"
                    >
                      <PencilIcon />
                    </IconButton>
                    <IconButton
                      onClick={() =>
                        setFullscreen({
                          kind: "dashboard",
                          id: d.id,
                          title: d.title,
                          description: d.description,
                          charts: stripLocalIds(d.charts),
                        })
                      }
                      ariaLabel={`View dashboard ${d.title} full screen`}
                      variant="neutral"
                    >
                      <ExpandIcon />
                    </IconButton>
                    <IconButton
                      onClick={() => deleteDashboard(d.id, d.title)}
                      disabled={deleting.has(d.id)}
                      ariaLabel={`Delete dashboard ${d.title}`}
                      variant="danger"
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                </div>
                {/*
                  Dashboard-wide filter bar (LIVELI-122). Only renders
                  when the agent declared filters on this dashboard;
                  legacy dashboards without filters show no bar at
                  all and behave exactly as before.
                */}
                {d.filters && d.filters.length > 0 && (
                  <FilterBar
                    filters={d.filters}
                    values={filterValuesByDashboard[d.id] ?? defaultFilterValues(d.filters)}
                    onChange={(v) => handleFilterChange(d.id, v)}
                    isUpdating={renderingByDashboard.has(d.id)}
                    onReset={() => resetFilters(d.id, d.filters!)}
                  />
                )}
                {/*
                  One DndContext per dashboard so drags are scoped — a
                  user can't pick a chart out of dashboard A and drop
                  it into dashboard B (which would be a confusing UX
                  and would also need a cross-doc API call we don't
                  have).
                */}
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(e: DragEndEvent) => {
                    if (!e.over || e.active.id === e.over.id) return;
                    reorderDashboardCharts(
                      d.id,
                      String(e.active.id),
                      String(e.over.id)
                    );
                  }}
                >
                  <SortableContext
                    items={d.charts.map((c) => c._localId)}
                    strategy={rectSortingStrategy}
                  >
                    {/*
                      4-column grid with 180px row units. Each tile
                      picks (col-span-N, row-span-M) based on its
                      colSpan:
                        Extra small — col-span-1 row-span-1 (¼ wide,  half tall)
                        Small       — col-span-1 row-span-2 (¼ wide,  full tall)
                        Medium      — col-span-2 row-span-2 (½ wide,  full tall)
                        Large       — col-span-4 row-span-2 (full,    full tall)
                      Existing charts without a colSpan field render
                      at Medium so layouts stay identical to before.
                    */}
                    <div className="grid gap-4 md:grid-cols-4 md:auto-rows-[180px]">
                      {d.charts.map((c, i) => (
                        <SortableChartTile
                          key={c._localId}
                          id={c._localId}
                          title={c.title}
                          spec={c.spec}
                          colSpan={c.colSpan ?? DEFAULT_COL_SPAN}
                          renderError={c._renderError}
                          settings={settings}
                          onExpand={() =>
                            setFullscreen({
                              kind: "chart",
                              // Synthetic id for charts inside a dashboard —
                              // the chart isn't a standalone saved-chart doc,
                              // it lives as a subdoc on the dashboard.
                              id: `${d.id}-${i}`,
                              title: c.title,
                              spec: c.spec,
                            })
                          }
                          onResize={(size) =>
                            resizeDashboardChart(d.id, c._localId, size)
                          }
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
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
              <ChartTile
                key={c.id}
                title={c.title}
                spec={c.spec}
                settings={settings}
                onExpand={() =>
                  setFullscreen({
                    kind: "chart",
                    id: c.id,
                    title: c.title,
                    spec: c.spec,
                  })
                }
                onEdit={() =>
                  openEditInChat({
                    kind: "chart",
                    id: c.id,
                    title: c.title,
                    spec: c.spec,
                  })
                }
                onDelete={() => deleteChart(c.id, c.title)}
                deleting={deleting.has(c.id)}
              />
            ))}
          </div>
        </section>
      )}

      <FullscreenModal
        content={fullscreen}
        onClose={() => setFullscreen(null)}
        onEdit={getFullscreenEditHandler(fullscreen, charts, openEditInChat)}
        settings={settings}
      />
    </div>
  );
}

/**
 * Derive the Edit-in-chat handler for whatever is currently fullscreened.
 *
 * - Dashboards are always editable — the modal opens for a dashboard
 *   document we own.
 * - Standalone charts are editable only if their id matches one of the
 *   saved-chart documents. Charts inside a dashboard use a synthetic
 *   id (`<dashboardId>-<index>`) and don't have a row of their own to
 *   update — to edit them you edit the parent dashboard. We detect
 *   that case by absence from `savedCharts` rather than parsing the id
 *   string, so the "is this a real chart doc" rule stays in one place.
 *
 * Returns undefined when there's nothing to edit; the modal then
 * doesn't render the Edit button.
 */
function getFullscreenEditHandler(
  fullscreen: FullscreenContent | null,
  savedCharts: SavedChart[],
  openEditInChat: (
    payload:
      | { kind: "chart"; id: string; title: string; spec: unknown }
      | {
          kind: "dashboard";
          id: string;
          title: string;
          description?: string | null;
          charts: Array<{ order: number; title: string; spec: unknown }>;
        }
  ) => void
): (() => void) | undefined {
  if (!fullscreen) return undefined;
  if (fullscreen.kind === "dashboard") {
    return () =>
      openEditInChat({
        kind: "dashboard",
        id: fullscreen.id,
        title: fullscreen.title,
        description: fullscreen.description,
        charts: fullscreen.charts,
      });
  }
  // chart kind — only editable if it's a standalone saved chart
  const isStandalone = savedCharts.some((c) => c.id === fullscreen.id);
  if (!isStandalone) return undefined;
  return () =>
    openEditInChat({
      kind: "chart",
      id: fullscreen.id,
      title: fullscreen.title,
      spec: fullscreen.spec,
    });
}

/**
 * dnd-kit sortable wrapper around ChartTile. Sets up the transform /
 * transition styles from useSortable, dims the dragged item while
 * it's airborne, and passes a grip-icon drag handle into ChartTile's
 * `dragHandle` slot. The grip carries the listeners + attributes — we
 * don't make the whole tile draggable because that would interfere
 * with clicks inside the ECharts canvas (tooltip, brush-zoom etc.).
 */
function SortableChartTile({
  id,
  title,
  spec,
  colSpan,
  onExpand,
  onResize,
  renderError,
  settings,
}: {
  id: string;
  title: string;
  spec: unknown;
  colSpan: ColSpan;
  onExpand?: () => void;
  onResize: (size: ColSpan) => void;
  /** Last /render error for this chart, if any. The displayed spec is the previous render's output. */
  renderError?: string;
  settings?: WorkspaceSettings;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 10 : undefined,
  };
  // col-span class lives on the OUTER wrapper (not on ChartTile's
  // root) because dnd-kit's setNodeRef element is what participates
  // in the CSS Grid. Putting col-span deeper would let the wrapper
  // claim its own implicit cell width.
  return (
    <div ref={setNodeRef} style={style} className={COL_SPAN_CLASSES[colSpan]}>
      <ChartTile
        title={title}
        spec={spec}
        renderError={renderError}
        onExpand={onExpand}
        compact={colSpan === "extra-small"}
        settings={settings}
        dragHandle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag to reorder ${title}`}
            className="shrink-0 cursor-grab touch-none rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary active:cursor-grabbing"
          >
            <GripIcon />
          </button>
        }
        sizePicker={<SizePicker current={colSpan} onChange={onResize} title={title} />}
      />
    </div>
  );
}

/**
 * Per-tile width picker. Click → a small popover opens with the
 * three size options; clicking one fires `onChange` and closes the
 * popover. The button itself shows the current size as a fraction
 * (¼ / ½ / Full) so the user can see what they have at a glance
 * without hovering.
 *
 * Click-outside-to-close is wired via a document-level mousedown
 * listener that's only registered while the popover is open. The
 * listener checks containment against the picker root ref to avoid
 * the "clicking the button to open it immediately fires the outside
 * handler" gotcha.
 */
function SizePicker({
  current,
  onChange,
  title,
}: {
  current: ColSpan;
  onChange: (size: ColSpan) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Resize chart ${title}, currently ${COL_SPAN_LABELS[current]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-7 min-w-[2.25rem] shrink-0 items-center justify-center rounded-md px-1.5 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
      >
        {COL_SPAN_BUTTON_LABELS[current]}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Chart width"
          className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          {(["extra-small", "small", "medium", "large"] as const).map((size) => {
            const selected = size === current;
            return (
              <button
                key={size}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(size);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                  selected
                    ? "bg-accent-muted text-accent"
                    : "text-text-secondary hover:bg-hover hover:text-text-primary"
                }`}
              >
                <span>{COL_SPAN_LABELS[size]}</span>
                {selected && <CheckIcon className="text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChartTile({
  title,
  spec,
  onExpand,
  onEdit,
  onDelete,
  deleting,
  dragHandle,
  sizePicker,
  renderError,
  compact = false,
  settings,
}: {
  title: string;
  spec: unknown;
  onExpand?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  dragHandle?: React.ReactNode;
  // Optional width-picker rendered in the action cluster. Only
  // present for inner-dashboard tiles; standalone saved-chart tiles
  // don't get a resize affordance because there's no per-chart
  // sizing concept on the saved-charts grid.
  sizePicker?: React.ReactNode;
  // When the most recent filter-driven re-render failed for this
  // chart, the server returns the previous spec unchanged plus an
  // error message. We surface it as a small inline banner so the
  // user doesn't read stale numbers without knowing they're stale.
  renderError?: string;
  /**
   * Extra-small tiles only occupy 1 row unit (≈180px). Compact mode
   * shrinks the chart canvas to fit so the tile doesn't overflow.
   * KPI-style single-value charts read fine at this height; bar /
   * line / pie charts will look cramped — those should use Small
   * or larger.
   */
  compact?: boolean;
  /** Workspace regional preferences (currency/locale/timezone). */
  settings?: WorkspaceSettings;
}) {
  return (
    <div className="card-elevated flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1">
          {dragHandle}
          <div className="truncate text-[13px] font-medium text-text-primary">{title}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {sizePicker}
          {onEdit && (
            <IconButton
              onClick={onEdit}
              ariaLabel={`Edit chart ${title}`}
              variant="neutral"
            >
              <PencilIcon />
            </IconButton>
          )}
          {onExpand && (
            <IconButton
              onClick={onExpand}
              ariaLabel={`View chart ${title} full screen`}
              variant="neutral"
            >
              <ExpandIcon />
            </IconButton>
          )}
          {onDelete && (
            <IconButton
              onClick={onDelete}
              disabled={!!deleting}
              ariaLabel={`Delete chart ${title}`}
              variant="danger"
            >
              <TrashIcon />
            </IconButton>
          )}
        </div>
      </div>
      <div className="p-3">
        {renderError && (
          <div
            className="mb-2 rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-2.5 py-1.5 text-[12px] text-[color:var(--status-error)]"
            role="status"
          >
            Couldn&apos;t refresh under current filters — showing previous result.
            <span className="ml-1 text-text-tertiary" title={renderError}>
              (details)
            </span>
          </div>
        )}
        <ChartRenderer spec={spec} height={compact ? 110 : 260} settings={settings} />
      </div>
    </div>
  );
}

/**
 * Compact icon-only action button. `variant`:
 *   - neutral: subtle hover (used for fullscreen/expand)
 *   - danger:  red hover (used for delete)
 */
function IconButton({
  onClick,
  disabled,
  ariaLabel,
  variant,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  variant: "neutral" | "danger";
  children: React.ReactNode;
}) {
  const base =
    "shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const hover =
    variant === "danger"
      ? "hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)]"
      : "hover:bg-hover hover:text-text-primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`${base} ${hover}`}
    >
      {children}
    </button>
  );
}
