import {
  VertexAI,
  type GenerativeModel,
  type ModelParams,
} from "@google-cloud/vertexai";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _vertex: VertexAI | null = null;

/**
 * Lazy-init Vertex AI client for Google's Gemini models. Auth via ADC —
 * `GOOGLE_APPLICATION_CREDENTIALS` points at a JSON file. Locally that's
 * `gcloud auth application-default login` output. On Vercel it's the
 * WIF external_account credentials file written to /tmp by
 * ensureGcpAuth().
 */
export function vertex(): VertexAI {
  if (_vertex) return _vertex;
  _vertex = new VertexAI({
    project: gcp.projectId,
    location: gcp.vertexRegion,
  });
  return _vertex;
}

/**
 * Fresh GenerativeModel per call. We pass systemInstruction at model
 * creation rather than per-request because:
 *  - v1.x SDK has cleaner semantics that way
 *  - the system prompt embeds the current date — caching the model
 *    would mean a stale date after the first request
 * Model objects are cheap to construct; just config + URL builders.
 */
export function buildModel(params: Omit<ModelParams, "model"> = {}): GenerativeModel {
  return vertex().getGenerativeModel({
    model: gcp.vertexModel,
    ...params,
  });
}

export async function vertexReady(): Promise<VertexAI> {
  await ensureGcpAuth();
  return vertex();
}

export const MODEL = gcp.vertexModel;
