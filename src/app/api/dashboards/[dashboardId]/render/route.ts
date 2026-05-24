import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, dashboardsIn } from "@/lib/firestore";
import { safeQuery } from "@/lib/bigquery";
import { substituteFilters } from "@/lib/dashboards/sql-template";
import type {
  ChartDataMapping,
  DynamicChartEntry,
  FilterDef,
  FilterValues,
} from "@/lib/dashboards/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Body schema is intentionally permissive — filter values can be many
 * different shapes (date range objects, granularity strings, single
 * strings, arrays of strings). Per-shape validation happens inside
 * the SQL substitution layer using each FilterDef as the contract.
 *
 * Loose at the API boundary, strict at the SQL boundary — same pattern
 * as run_sql. The thing that actually matters for safety (no
 * injection, no DDL) is the substitution layer + the runtime SQL
 * check.
 */
const Body = z.object({
  filterValues: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Render a dashboard's charts under a set of filter values.
 *
 * Phase 1 of LIVELI-122 (dashboard filters). For each chart with a
 * `sourceSql` template + `dataMapping`, this endpoint:
 *
 *   1. Substitutes the client-supplied filter values into the chart's
 *      SQL template (placeholders are `{{filter:<id>.<field>}}`)
 *   2. Re-runs the substituted SQL via the workspace's BigQuery
 *      client, with the same scan-cap protection run_sql uses
 *   3. Re-assembles a chart spec by mapping result columns onto the
 *      ECharts option positions declared in `dataMapping`
 *
 * Charts WITHOUT sourceSql/dataMapping fall back to their stored
 * static spec — preserves full backward compat for dashboards
 * created before LIVELI-122 lands.
 *
 * Response shape mirrors a dashboard read: title + description +
 * charts[]. Each chart has the same shape it had at save time, but
 * with `spec` refreshed under the current filter values where the
 * chart supports re-rendering.
 *
 * Workspace-scoped lookup — a request authenticated to workspace A
 * can't render dashboards owned by workspace B (the `dashboardsIn`
 * helper enforces this via the document path).
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ dashboardId: string }> }
) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const { dashboardId } = await context.params;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  await dbReady();
  const ref = dashboardsIn(ctx.clientId, ctx.workspaceId).doc(dashboardId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Dashboard not found" }, { status: 404 });
  }

  const data = snap.data() as {
    title?: string;
    description?: string | null;
    filters?: FilterDef[];
    charts?: DynamicChartEntry[];
  };

  const filters = data.filters ?? [];
  const filterValues = body.filterValues as FilterValues;
  const charts = data.charts ?? [];

  // Re-render each chart in parallel — independent SQL queries with
  // independent failure surfaces. One chart failing should NOT block
  // the others from re-rendering.
  const renderedCharts = await Promise.all(
    charts.map(async (chart) => renderChart(chart, filters, filterValues, ctx))
  );

  return Response.json({
    title: data.title,
    description: data.description ?? null,
    filters,
    charts: renderedCharts,
  });
}

/**
 * Render one chart under the current filter values.
 *
 * If the chart has sourceSql + dataMapping, re-runs the query and
 * rebuilds the spec. Otherwise returns the chart unchanged (static
 * fallback for legacy charts).
 *
 * Errors during re-render don't throw — we attach an `error` field
 * to the chart and return the original spec so the rest of the
 * dashboard still renders. The client decides how to display the
 * per-chart error.
 */
async function renderChart(
  chart: DynamicChartEntry,
  filters: FilterDef[],
  filterValues: FilterValues,
  ctx: { clientId: string; workspaceId: string; userId: string }
): Promise<
  DynamicChartEntry & { error?: string }
> {
  if (!chart.sourceSql || !chart.dataMapping) {
    // Static chart — no re-render path.
    return chart;
  }

  try {
    const substituted = substituteFilters(chart.sourceSql, filters, filterValues);
    const result = await safeQuery(substituted, {
      maxRows: 1000,
      context: {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      },
    });
    const refreshedSpec = rebuildChartSpec(chart.spec, chart.dataMapping, result.rows);
    return { ...chart, spec: refreshedSpec };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[dashboards/render] chart re-render failed", {
      chartTitle: chart.title,
      error: message,
    });
    return { ...chart, error: message };
  }
}

/**
 * Rebuild a chart spec by pulling column arrays from the result rows
 * and slotting them into the positions declared by dataMapping.
 *
 * The existing spec is used as a template — we preserve everything
 * the agent set (title, tooltip, legend, series types, etc.) and
 * only replace the data positions. That means visualisation choices
 * (chart type, colours, axis types) survive re-renders intact.
 *
 * Returns the original spec untouched if any dataMapping column
 * isn't present in the result — defensive against schema drift.
 */
function rebuildChartSpec(
  originalSpec: unknown,
  mapping: ChartDataMapping,
  rows: Record<string, unknown>[]
): unknown {
  if (!originalSpec || typeof originalSpec !== "object") return originalSpec;
  const spec = { ...(originalSpec as Record<string, unknown>) };

  // Build column arrays from the rows. Map<columnName, value[]>.
  const columns = new Map<string, unknown[]>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!columns.has(k)) columns.set(k, []);
      columns.get(k)!.push(v);
    }
  }

  // xAxis.data
  if (mapping.xAxis) {
    const xCol = columns.get(mapping.xAxis.dataColumn);
    if (xCol) {
      const existingXAxis = (spec.xAxis as Record<string, unknown> | undefined) ?? {};
      spec.xAxis = {
        ...existingXAxis,
        data: xCol.map((v) => (v == null ? "" : String(v))),
      };
    }
  }

  // series[].data — preserve existing series structure, only swap data
  if (Array.isArray(spec.series)) {
    spec.series = (spec.series as Array<Record<string, unknown>>).map((s, i) => {
      const seriesMap = mapping.series[i];
      if (!seriesMap) return s;
      const col = columns.get(seriesMap.dataColumn);
      if (!col) return s;
      // Coerce non-numeric values to 0 for safety — ECharts series.data
      // expects numbers. NaN-shaped values render as gaps in line
      // charts and 0-height bars; both acceptable degradations.
      const numericCol = col.map((v) => (typeof v === "number" ? v : Number(v) || 0));
      return {
        ...s,
        ...(seriesMap.name ? { name: seriesMap.name } : {}),
        data: numericCol,
      };
    });
  }

  return spec;
}
