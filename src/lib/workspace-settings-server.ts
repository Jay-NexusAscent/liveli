import { auth } from "@clerk/nextjs/server";
import { getDefaultWorkspaceId } from "@/lib/clients";
import { dbReady, workspaceDoc } from "@/lib/firestore";
import {
  mergeSettings,
  holidayRegionForCountry,
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

/**
 * Regional context for in-warehouse ML (forecasting / anomaly detection),
 * keyed by explicit clientId + workspaceId (the agent tools have these in
 * their AgentContext, not Clerk's ambient auth). One workspace-doc read
 * yields everything the BQML engine needs:
 *
 *   - `bqLocation` — data residency ("EU" | "US"). Models MUST be created
 *     in the same location as the source data; defaults to "EU" (matches
 *     the workspace default) when unset.
 *   - `settings`   — merged-with-defaults WorkspaceSettings (timezone is
 *     the one the agent buckets dates in).
 *   - `holidayRegion` — BQML holiday calendar derived from settings.country,
 *     or undefined → no holiday modelling.
 */
export async function getWorkspaceRegional(
  clientId: string,
  workspaceId: string
): Promise<{
  bqLocation: "EU" | "US";
  settings: WorkspaceSettings;
  holidayRegion?: string;
}> {
  await dbReady();
  const snap = await workspaceDoc(clientId, workspaceId).get();
  const data = snap.data() as
    | { bqLocation?: "EU" | "US"; settings?: Partial<WorkspaceSettings> }
    | undefined;
  const settings = mergeSettings(data?.settings);
  return {
    bqLocation: data?.bqLocation === "US" ? "US" : "EU",
    settings,
    holidayRegion: holidayRegionForCountry(settings.country),
  };
}
