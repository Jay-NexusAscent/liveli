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
  // Vertex AI endpoint type. For Claude Opus 4.7 / Sonnet 4.6 / Haiku
  // 4.5 the supported endpoints are "global" (recommended, default
  // pricing), "us" or "eu" (multi-region with 10% premium, useful for
  // data-residency tiers), or specific regions like "us-east1" /
  // "europe-west1" for provisioned throughput. The old "us-central1"
  // regional endpoint does NOT serve Opus 4.7.
  // Ref: https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai
  vertexRegion: process.env.VERTEX_AI_REGION ?? "global",
  vertexModel: process.env.VERTEX_AI_MODEL ?? "claude-opus-4-7",
} as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
