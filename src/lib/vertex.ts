import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _client: AnthropicVertex | null = null;

/**
 * Lazy-init Anthropic client pointed at Vertex AI. Auth via ADC —
 * GOOGLE_APPLICATION_CREDENTIALS points at a JSON file. Locally that's
 * the user's `gcloud auth application-default login` ADC. On Vercel it's
 * the WIF external_account credentials written to /tmp by ensureGcpAuth().
 */
export function vertex(): AnthropicVertex {
  if (_client) return _client;
  _client = new AnthropicVertex({
    projectId: gcp.projectId,
    region: gcp.vertexRegion,
  });
  return _client;
}

export async function vertexReady(): Promise<AnthropicVertex> {
  await ensureGcpAuth();
  return vertex();
}

export const MODEL = gcp.vertexModel;
