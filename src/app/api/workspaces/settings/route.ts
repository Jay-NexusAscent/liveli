import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, workspaceDoc } from "@/lib/firestore";
import {
  mergeSettings,
  validateSettingsPatch,
  type WorkspaceSettings,
} from "@/lib/workspace-settings";

export const runtime = "nodejs";

/**
 * GET /api/workspaces/settings — return the current workspace's
 * effective settings (stored merged with DEFAULT_WORKSPACE_SETTINGS so
 * the response is always a complete record).
 *
 * PATCH /api/workspaces/settings — partial update. Each field is
 * validated individually via validateSettingsPatch (currency = ISO 4217,
 * timezone = IANA, fiscalYearStartMonth = 1-12, etc.). Unknown fields
 * are silently dropped (validator allow-lists known keys).
 */
export async function GET() {
  try {
    const { clientId, workspaceId } = await requireWorkspaceContext();
    const db = await dbReady();
    void db; // Firestore is initialised by dbReady; we call workspaceDoc next.
    const snap = await workspaceDoc(clientId, workspaceId).get();
    const data = snap.data() as { settings?: Partial<WorkspaceSettings> } | undefined;
    return Response.json({ settings: mergeSettings(data?.settings) });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[settings] GET failed", err);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = validateSettingsPatch(raw);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const { clientId, workspaceId } = await requireWorkspaceContext();
    await dbReady();
    const ref = workspaceDoc(clientId, workspaceId);

    // Nested merge — Firestore's `merge: true` on a top-level update
    // would replace `settings` wholesale. Use dotted-path updates so
    // ONLY the fields in the patch change; others keep their existing
    // value.
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.value)) {
      patch[`settings.${k}`] = v;
    }
    await ref.set(patch, { merge: true });

    const snap = await ref.get();
    const data = snap.data() as { settings?: Partial<WorkspaceSettings> } | undefined;
    return Response.json({ settings: mergeSettings(data?.settings) });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[settings] PATCH failed", err);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
