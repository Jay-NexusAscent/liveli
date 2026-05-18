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
  // Vertex AI location for Gemini models. "global" routes dynamically,
  // "us-central1" / "europe-west1" / etc. for region-pinning. Most
  // Gemini models are available across many regions — pick the closest
  // to your workload. We default to europe-west1 since the rest of the
  // stack is EU.
  // Ref: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models
  vertexRegion: process.env.VERTEX_AI_REGION ?? "global",
  // Gemini 3 Flash (preview as of mid-2026) — fast, cheap, supports
  // function calling. Set VERTEX_AI_MODEL to override (e.g. for
  // gemini-2.5-flash GA, or gemini-3-pro for harder reasoning).
  vertexModel: process.env.VERTEX_AI_MODEL ?? "gemini-3-flash-preview",
} as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
