/**
 * Shared GCP config. Reads from env once at module load.
 * Production uses Workload Identity Federation (no key file);
 * local dev sets GOOGLE_APPLICATION_CREDENTIALS to a SA JSON path.
 */

export const gcp = {
  projectId: requireEnv("GCP_PROJECT_ID"),
  region: process.env.GCP_REGION ?? "europe-west4",
  bqLocation: process.env.GCP_BQ_LOCATION ?? "EU",
  firestoreDatabase: process.env.GCP_FIRESTORE_DATABASE ?? "(default)",
  /**
   * Default Vertex region — used only when a workspace has no
   * `bqLocation` set (legacy / orphan workspaces). The primary path
   * is per-workspace via `vertexRegionForResidency(workspace.bqLocation)`.
   *
   * The @google-cloud/vertexai SDK formats the API URL as
   *   https://${location}-aiplatform.googleapis.com
   * so the value MUST be a real regional string. "global" produces
   * https://global-aiplatform.googleapis.com which doesn't exist —
   * Google returns an HTML 404 the SDK then mis-parses as JSON. See
   * the throw in vertex.ts for the runtime guard.
   */
  vertexRegion: process.env.VERTEX_AI_REGION ?? "europe-west1",
  /**
   * Default model. Must be available in the workspace's residency region.
   * gemini-2.5-flash is the latest Flash variant available in europe-west1
   * as of 2026-05. gemini-3.5-flash exists but only in us-central1/global
   * for now — switching there would break EU data residency. Re-check
   * regional availability before bumping this default.
   */
  vertexModel: process.env.VERTEX_AI_MODEL ?? "gemini-2.5-flash",
} as const;

/**
 * Map a workspace's data-residency choice to the Vertex AI region the
 * agent should target. Keeps inference in the customer's residency
 * zone so we honour LIVELI's data-residency promise end-to-end (data
 * at rest in BQ/Firestore/GCS, AND the inference call itself).
 *
 * EU → europe-west1 (same region family as our Cloud Run / Artifact
 *      Registry / Secret Manager footprint, also serves Gemini family)
 * US → us-central1 (the canonical Vertex Gemini region, max model
 *      availability)
 *
 * Multi-region values like "eu" / "us" are NOT used here — the
 * @google-cloud/vertexai SDK builds `${region}-aiplatform.googleapis.com`
 * hostnames and only true regional names resolve.
 */
export function vertexRegionForResidency(
  bqLocation: "EU" | "US" | undefined
): string {
  switch (bqLocation) {
    case "US":
      return "us-central1";
    case "EU":
    default:
      return "europe-west1";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
