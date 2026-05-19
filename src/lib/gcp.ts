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
  // Vertex AI location for Gemini models.
  //
  // IMPORTANT: the @google-cloud/vertexai SDK formats the API URL as
  //   https://${location}-aiplatform.googleapis.com
  // It does NOT support "global" as a location string (that was an
  // Anthropic-Vertex-SDK convenience). The "global" endpoint exists
  // at the underlying API level (host: aiplatform.googleapis.com)
  // but this SDK can't target it. Using "global" here produces 404
  // HTML responses from a non-existent hostname, which surface as
  // JSON.parse SyntaxError on '<!DOCTYPE'.
  //
  // Always set this to a real regional string: europe-west1 / us-central1
  // / asia-northeast1 etc. We default to europe-west1 for EU residency.
  // Ref: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations
  vertexRegion: process.env.VERTEX_AI_REGION ?? "europe-west1",
  // Default to gemini-2.5-flash (GA, default-enabled in every GCP
  // project — no Model Garden enablement step). Override via env to
  // gemini-3-flash-preview (latest but requires Model Garden enable) or
  // gemini-3-pro for harder reasoning.
  vertexModel: process.env.VERTEX_AI_MODEL ?? "gemini-2.5-flash",
} as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
