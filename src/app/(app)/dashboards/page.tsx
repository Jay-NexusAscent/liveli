"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DashboardIcon,
  ExpandIcon,
  PencilIcon,
  SparkleIcon,
  TrashIcon,
} from "@/components/icons";
import { FullscreenModal } from "@/components/dashboards/fullscreen-modal";
import { ChartRenderer } from "@/components/chat/chart-renderer";

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

type FullscreenContent =
  | { kind: "chart"; id: string; title: string; spec: unknown }
  | {
      kind: "dashboard";
      id: string;
      title: string;
      description?: string | null;
      charts: Array<{ order: number; title: string; spec: unknown }>;
    };

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
        if (dashRes.ok) setDashboards((await dashRes.json()).items ?? []);
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
                          charts: d.charts,
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
                          charts: d.charts,
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
                <div className="grid gap-4 md:grid-cols-2">
                  {d.charts.map((c, i) => (
                    <ChartTile
                      key={i}
                      title={c.title}
                      spec={c.spec}
                      onExpand={() =>
                        setFullscreen({
                          kind: "chart",
                          // Synthetic id for charts inside a dashboard —
                          // the chart isn't a standalone saved-chart doc,
                          // it lives as a subdoc on the dashboard. The
                          // share link still resolves (anchor maps to the
                          // tile within the dashboard view).
                          id: `${d.id}-${i}`,
                          title: c.title,
                          spec: c.spec,
                        })
                      }
                    />
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

function ChartTile({
  title,
  spec,
  onExpand,
  onEdit,
  onDelete,
  deleting,
}: {
  title: string;
  spec: unknown;
  onExpand?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  return (
    <div className="card-elevated overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="truncate text-[13px] font-medium text-text-primary">{title}</div>
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
