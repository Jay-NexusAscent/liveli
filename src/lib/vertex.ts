import {
  VertexAI,
  type GenerativeModel,
  type ModelParams,
} from "@google-cloud/vertexai";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _vertex: VertexAI | null = null;
let _fetchPatched = false;

/**
 * Diagnostic: wrap globalThis.fetch so every *.googleapis.com request
 * logs URL + status + (on error/HTML) first 500 chars of the body.
 *
 * Why: when @google-cloud/vertexai gets an HTML response it throws
 * `Unexpected token '<', "<!DOCTYPE "...` from inside JSON.parse. The
 * underlying Response is captured inside the SyntaxError where it's
 * inaccessible. Patching fetch is the only way to see the body.
 *
 * Authorization headers redacted. Response is .clone()'d before
 * peek-reading so the SDK still consumes the original.
 * Idempotent across HMR reloads.
 */
function installVertexFetchDiagnostics(): void {
  if (_fetchPatched) return;
  if (typeof globalThis.fetch !== "function") return;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (!/googleapis\.com/.test(url)) {
      return originalFetch(input, init);
    }

    const method =
      init?.method ??
      (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");

    const headers = new Headers(init?.headers);
    if (headers.has("authorization")) headers.set("authorization", "[redacted]");
    const headerSummary: Record<string, string> = {};
    headers.forEach((v, k) => {
      headerSummary[k] = v;
    });

    console.log("[vertex-fetch] →", { method, url, headers: headerSummary });

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      console.error("[vertex-fetch] network error", {
        url,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const status = response.status;
    const contentType = response.headers.get("content-type") ?? "";
    const isStreamable = /application\/json|text\/event-stream/.test(contentType);

    if (!response.ok || !isStreamable) {
      let preview = "";
      try {
        preview = (await response.clone().text()).slice(0, 1500);
      } catch {
        preview = "[body unreadable]";
      }
      console.error("[vertex-fetch] suspect response", {
        url,
        status,
        contentType,
        bodyPreview: preview,
      });
      // Surface the body via the error message — Vercel's runtime-logs
      // MCP truncates console output to ~30 chars per row, but the SSE
      // error event preserves err.message in full and renders it
      // verbatim in the chat UI. Throwing here means the body lands
      // where we can actually read it.
      const sanitised = preview.replace(/\s+/g, " ").trim();
      throw new Error(
        `[vertex-fetch] non-JSON response ${status} (${contentType || "no content-type"}) from ${url} — body: ${sanitised}`
      );
    } else {
      console.log("[vertex-fetch] ←", { url, status, contentType });
    }

    return response;
  }) as typeof fetch;

  _fetchPatched = true;
}

/**
 * Lazy-init Vertex AI client for Google's Gemini models. Auth via ADC —
 * `GOOGLE_APPLICATION_CREDENTIALS` points at a JSON file. Locally that's
 * `gcloud auth application-default login` output. On Vercel it's the
 * WIF external_account credentials file written to /tmp by
 * ensureGcpAuth().
 */
export function vertex(): VertexAI {
  if (_vertex) return _vertex;
  installVertexFetchDiagnostics();
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
