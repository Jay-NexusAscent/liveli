"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DashboardIcon,
  ExpandIcon,
  GripIcon,
  PencilIcon,
  SparkleIcon,
  TrashIcon,
} from "@/components/icons";
import { FullscreenModal } from "@/components/dashboards/fullscreen-modal";
import { ChartRenderer } from "@/components/chat/chart-renderer";
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
  _localId: string;
}

interface SavedDashboard {
  id: string;
  title: string;
  description?: string | null;
  charts: DashboardChart[];
}

type FullscreenContent =
  | { kind: "chart"; id: string; title: string; spec: unknown }
  | {
      kind: "dashboard";
      id: string;
      title: string;
      description?: string | null;
      charts: Array<{ order: number; title: string; spec: unknown }>;
    };

/**
 * Drop the client-only `_localId` field before sending charts to the
 * API or into the edit-via-chat sessionStorage payload. Keeps the
 * server contract clean and avoids leaking a meaningless UUID into
 * the LLM's edit-mode preamble.
 */
function stripLocalIds(
  charts: DashboardChart[]
): Array<{ order: number; title: string; spec: unknown }> {
  return charts.map((c) => ({ order: c.order, title: c.title, spec: c.spec }));
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
        const [chartsRes, dashRes] = await Promise.all([
          fetch("/api/charts"),
          fetch("/api/dashboards"),
        ]);
        if (chartsRes.ok) setCharts((await chartsRes.json()).items ?? []);
        if (dashRes.ok) {
          // Hydrate the server-side dashboards with stable client-side
          // ids on each chart so dnd-kit's SortableContext has IDs
          // that survive reordering.
          type ServerChart = { order: number; title: string; spec: unknown };
          type ServerDashboard = Omit<SavedDashboard, "charts"> & { charts: ServerChart[] };
          const items: ServerDashboard[] = (await dashRes.json()).items ?? [];
          setDashboards(
            items.map((d) => ({
              ...d,
              charts: d.charts.map((c) => ({ ...c, _localId: crypto.randomUUID() })),
            }))
          );
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
                    <div className="grid gap-4 md:grid-cols-2">
                      {d.charts.map((c, i) => (
                        <SortableChartTile
                          key={c._localId}
                          id={c._localId}
                          title={c.title}
                          spec={c.spec}
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
  onExpand,
}: {
  id: string;
  title: string;
  spec: unknown;
  onExpand?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <ChartTile
        title={title}
        spec={spec}
        onExpand={onExpand}
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
      />
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
}: {
  title: string;
  spec: unknown;
  onExpand?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  dragHandle?: React.ReactNode;
}) {
  return (
    <div className="card-elevated overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1">
          {dragHandle}
          <div className="truncate text-[13px] font-medium text-text-primary">{title}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
        <ChartRenderer spec={spec} height={260} />
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
