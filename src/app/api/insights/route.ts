import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, insightsIn } from "@/lib/firestore";
import { createInsight } from "@/lib/insights/create";
import {
  clampFrequency,
  FREQUENCY_VALUES,
  type InsightFrequency,
} from "@/lib/insights/frequency";
import type { InsightCategory, RuleType } from "@/lib/insights/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * List all insights for the current workspace, newest-fired-first then
 * newest-created. The UI splits the response into "Active alerts"
 * (status === "fired") and "Tracking" (status === "idle") sections,
 * but server-side we don't pre-split — keeping it one list avoids
 * a duplicate query and lets the client decide ordering nuance.
 *
 * Ordered by createdAt desc to match how the rest of the workspace
 * surface (dashboards, charts) returns items. Sorting by status
 * happens client-side.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  await dbReady();
  const snap = await insightsIn(ctx.clientId, ctx.workspaceId)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return Response.json({ items });
}

/**
 * Body schema mirrors the proposal shape emitted by propose_insights.
 * Both code paths (agent's save_insight tool + UI's accept-proposal
 * POST) share `createInsight()` under the hood — see
 * `src/lib/insights/create.ts`.
 *
 * Why is this NEEDED in addition to save_insight tool? When the user
 * accepts a proposal card in chat, the UI is doing the work, not the
 * agent. We don't want to bounce back through the chat completion to
 * trigger save_insight — that's slow, costs tokens, and adds a
 * meaningless conversational round-trip. The endpoint is a direct
 * shortcut for the user-as-actor case.
 */
const PostBody = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(400),
  category: z.enum(["Sales", "Customer", "Operational", "Growth"]),
  sourceSql: z.string().min(1),
  sourceConnector: z.string().max(80).optional(),
  ruleType: z.enum([
    "change_pct_above",
    "change_pct_below",
    "value_above",
    "value_below",
  ]),
  threshold: z.number(),
  prefill: z.string().min(1).max(400),
  frequency: z
    .enum(FREQUENCY_VALUES as readonly [InsightFrequency, ...InsightFrequency[]])
    .optional(),
});

/**
 * Create an insight from a UI-side accept (proposal card → Save).
 * Runs the same createInsight() helper as the agent's save_insight
 * tool, so behaviour is identical: SQL runs once at save time,
 * scalar contract enforced, currentValue seeded, rule applied, doc
 * written to Firestore.
 *
 * SQL or contract failures return 400 with the message — the proposal
 * card UI surfaces it inline so the user can ask the agent to fix
 * the SQL rather than getting a generic 500.
 */
export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  await dbReady();

  try {
    const result = await createInsight(
      {
        title: body.title,
        description: body.description,
        category: body.category as InsightCategory,
        sourceSql: body.sourceSql,
        sourceConnector: body.sourceConnector,
        ruleType: body.ruleType as RuleType,
        threshold: body.threshold,
        prefill: body.prefill,
        // Tier-clamp before persistence. Today this is a passthrough
        // (no gate); when LIVELI-125 adds tier limits, requests for
        // a tighter cadence than the workspace's tier allows get
        // downgraded here rather than the API erroring — the user
        // wanted the insight; we give them the tightest schedule we
        // can on their plan and the UI explains the clamp.
        frequency: clampFrequency(
          body.frequency as InsightFrequency | undefined,
          undefined /* tier — wire from ctx.workspace once tier is on workspace doc */
        ),
      },
      {
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      }
    );
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 400 });
  }
}
