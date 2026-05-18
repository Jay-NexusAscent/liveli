import { VertexAI, type GenerativeModel } from "@google-cloud/vertexai";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _vertex: VertexAI | null = null;
let _model: GenerativeModel | null = null;

/**
 * Lazy-init Vertex AI client for Google's Gemini models. Auth via ADC —
 * `GOOGLE_APPLICATION_CREDENTIALS` points at a JSON file. Locally that's
 * `gcloud auth application-default login` output. On Vercel it's the
 * WIF external_account credentials file written to /tmp by
 * ensureGcpAuth().
 *
 * Vertex AI for Gemini is REST-by-default via @google-cloud/vertexai's
 * underlying transport (google-auth-library + fetch) — no gRPC fallback
 * needed unlike Firestore / Secret Manager / Cloud Run.
 */
export function vertex(): VertexAI {
  if (_vertex) return _vertex;
  _vertex = new VertexAI({
    project: gcp.projectId,
    location: gcp.vertexRegion,
  });
  return _vertex;
}

export function generativeModel(): GenerativeModel {
  if (_model) return _model;
  _model = vertex().getGenerativeModel({
    model: gcp.vertexModel,
  });
  return _model;
}

export async function vertexReady(): Promise<GenerativeModel> {
  await ensureGcpAuth();
  return generativeModel();
}

export const MODEL = gcp.vertexModel;
