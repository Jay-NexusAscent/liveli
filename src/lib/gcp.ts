/**
 * Shared GCP config.
 *
 * `projectId` is read LAZILY via a getter — the env var lookup happens
 * on first access, not at module load. This is the difference between
 * production and preview Vercel builds: production has GCP_PROJECT_ID
 * set, preview doesn't. With an eager `requireEnv()` at module load,
 * preview builds crashed during Next.js "collect page data" for every
 * API route that imported this file (transitively most of them).
 * Lazy access means the build phase doesn't need the env, only request
 * handlers that actually touch GCP do.
 *
 * Production uses Workload Identity Federation (no key file);
 * local dev sets GOOGLE_APPLICATION_CREDENTIALS to a SA JSON path.
 */

let _projectId: string | undefined;

export const gcp = {
  /**
   * GCP project ID. First access reads + caches; subsequent accesses
   * return the cached value. Throws if GCP_PROJECT_ID isn't set.
   */
  get projectId(): string {
    return (_projectId ??= requireEnv("GCP_PROJECT_ID"));
  },
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
   * Default agent model. Must be available in the workspace's residency
   * region. Liveli runs on Gemini (Vertex AI) — Gemini 2.5 Flash is the
   * default workhorse; complex turns can be routed to a Pro model via
   * VERTEX_AI_MODEL_LIGHT-style config (see below) / per-turn selection.
   *
   * Override with VERTEX_AI_MODEL to pin a specific Gemini model. The
   * agent loop lives in src/lib/agent.ts (@google-cloud/vertexai).
   *
   * Regional availability: the Gemini family is served from `eu`, `us`,
   * and `global` Vertex endpoints. Workspace data-residency choice in
   * vertexRegionForResidency() still drives which endpoint is used.
   */
  vertexModel: process.env.VERTEX_AI_MODEL ?? "gemini-2.5-flash",
  /**
   * Optional light/cheap model for routing simple queries away from
   * the primary model. When set, the agent classifies the incoming user
   * message; "simple" queries (single-value lookups, short single-table
   * questions, no edit context, no analytics trigger words) route to
   * this model; "complex" queries (dashboards, comparisons, edits) stay
   * on the primary.
   *
   * Recommended value: `gemini-2.5-flash-lite` — cheaper than Flash,
   * plenty capable for simple Q&A. Leaving unset disables routing
   * entirely (everything uses `vertexModel`), which is the safe default
   * until baseline cost/quality data exists.
   *
   * The classification logic in agent.ts is deterministic and runs in
   * microseconds — no extra LLM call, no added latency.
   */
  vertexModelLight: process.env.VERTEX_AI_MODEL_LIGHT,
};

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

/**
 * Map a workspace's data-residency choice to the GCP region the
 * connector Cloud Run Jobs + their Cloud Scheduler triggers should
 * live in. Same residency promise as vertexRegionForResidency, applied
 * to compute (not inference).
 *
 * The `suffix` is used in Cloud Run Job names — `connector-<type>-to-bq-eu`
 * vs `-us` — because the same job name can coexist across regions, but
 * a single global naming scheme makes it unambiguous which residency
 * footprint a job belongs to. Mirroring the vertex region (europe-west1
 * for EU) keeps our entire EU footprint in one regional family —
 * Vertex, Cloud Run, Scheduler all in europe-west1.
 *
 * EU → europe-west1
 * US → us-central1 (matches us-central1 Vertex region)
 */
export function cloudComputeRegionForResidency(
  bqLocation: "EU" | "US" | undefined
): { region: string; suffix: "eu" | "us" } {
  if (bqLocation === "US") return { region: "us-central1", suffix: "us" };
  return { region: "europe-west1", suffix: "eu" };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
