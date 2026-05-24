import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, insightsIn } from "@/lib/firestore";
import {
  clampFrequency,
  FREQUENCY_VALUES,
  type InsightFrequency,
} from "@/lib/insights/frequency";

export const runtime = "nodejs";

/**
 * Delete a saved insight. Workspace-scoped via the `insightsIn` path
 * — a request authenticated to workspace A can't delete insights
 * owned by workspace B. Returns 404 for missing OR mis-scoped ids.
 *
 * No soft-delete in v1 — when LIVELI-75 adds the 30-day grace period
 * for accounts, insights will inherit that policy automatically since
 * they live under the workspace doc.
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ insightId: string }> }
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

  const { insightId } = await context.params;

  await dbReady();
  const ref = insightsIn(ctx.clientId, ctx.workspaceId).doc(insightId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Insight not found" }, { status: 404 });
  }
  await ref.delete();
  return Response.json({ ok: true });
}

/**
 * Partial-update body. v1 only frequency is editable — other fields
 * (title, sourceSql, rule) would require re-running the SQL to re-seed
 * values and there's no UX surface for that yet. When edit-via-chat
 * for insights ships (parallel to update_dashboard), this body
 * extends.
 */
const PatchBody = z.object({
  frequency: z
    .enum(FREQUENCY_VALUES as readonly [InsightFrequency, ...InsightFrequency[]])
    .optional(),
});

/**
 * Update an insight's editable fields. Currently just frequency —
 * the picker on each insight card hits this endpoint.
 *
 * Frequency goes through clampFrequency before write, so a UI that
 * sends a tighter cadence than the workspace tier allows still
 * persists a valid value rather than 400-ing the request. Today the
 * clamp is a passthrough (no tier gate yet — see LIVELI-125).
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ insightId: string }> }
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

  const { insightId } = await context.params;

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  if (body.frequency === undefined) {
    return Response.json(
      { error: "No editable fields supplied. Pass `frequency`." },
      { status: 400 }
    );
  }

  await dbReady();
  const ref = insightsIn(ctx.clientId, ctx.workspaceId).doc(insightId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Insight not found" }, { status: 404 });
  }

  const nextFrequency = clampFrequency(
    body.frequency as InsightFrequency,
    undefined /* tier — wire when LIVELI-125 lands */
  );

  await ref.update({
    frequency: nextFrequency,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return Response.json({ ok: true, frequency: nextFrequency });
}
