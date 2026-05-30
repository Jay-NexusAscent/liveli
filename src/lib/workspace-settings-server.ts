import { auth } from "@clerk/nextjs/server";
import { getDefaultWorkspaceId } from "@/lib/clients";
import { dbReady, workspaceDoc } from "@/lib/firestore";
import {
  mergeSettings,
  type WorkspaceSettings,
} from "@/lib/workspace-settings";

/**
 * Server-side helper for any (app)-tree page that wants to thread the
 * current workspace's settings into a client component (chat, dashboards
 * page, etc.). Returns the merged-with-defaults settings; falls back to
 * pure defaults when the user isn't auth'd or has no provisioned
 * client/workspace yet (rare, pre-onboarding).
 *
 * Kept separate from `workspace-settings.ts` because that module is
 * imported into client components (the form, chart-renderer) — pulling
 * Firestore + Clerk auth into client bundles would explode them.
 */
export async function fetchWorkspaceSettingsForCurrentUser(): Promise<WorkspaceSettings> {
  const { orgId } = await auth();
  if (!orgId) return mergeSettings();

  await dbReady();
  const workspaceId = await getDefaultWorkspaceId(orgId);
  if (!workspaceId) return mergeSettings();

  const snap = await workspaceDoc(orgId, workspaceId).get();
  const data = snap.data() as
    | { settings?: Partial<WorkspaceSettings> }
    | undefined;
  return mergeSettings(data?.settings);
}
