import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { gcp } from "@/lib/gcp";

let _client: AnthropicVertex | null = null;

/**
 * Lazy-init Anthropic client pointed at Vertex AI. ADC handles credentials —
 * locally via GOOGLE_APPLICATION_CREDENTIALS, on Vercel via Workload Identity
 * Federation. The Anthropic SDK API surface is identical to the public one,
 * just constructed with projectId + region instead of an API key.
 */
export function vertex(): AnthropicVertex {
  if (_client) return _client;
  _client = new AnthropicVertex({
    projectId: gcp.projectId,
    region: gcp.vertexRegion,
  });
  return _client;
}

export const MODEL = gcp.vertexModel;
