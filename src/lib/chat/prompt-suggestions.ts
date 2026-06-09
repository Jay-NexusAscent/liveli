import { createHash } from "node:crypto";
import { FieldValue } from "@google-cloud/firestore";
import type { Part } from "@google-cloud/vertexai";
import { connectorsIn, dbReady, workspaceDoc } from "@/lib/firestore";
import { listWorkspaceTables, type WorkspaceTable } from "@/lib/bigquery";
import { getWorkspaceRegional } from "@/lib/workspace-settings-server";
import { vertexRegionForResidency } from "@/lib/gcp";
import { buildModel, vertexReady } from "@/lib/vertex";

/**
 * Static fallback shown when a workspace has no connected data yet (or
 * when generation fails). Deliberately retail/SaaS-generic — the moment
 * a workspace has tables, these are replaced by data-aware questions.
 */
export const DEFAULT_PROMPT_SUGGESTIONS = [
  "What were our top 5 products by revenue last quarter?",
  "Show weekly new users for the last 90 days",
  "Which countries drive the highest order value?",
  "Build me a dashboard with sales overview",
];

const SUGGESTION_COUNT = 4;

/**
 * Gemini Flash ONLY — Liveli's stack is Gemini, never Claude. We pass an
 * explicit model id rather than `gcp.vertexModel` (whose default would
 * route to a Claude model via the AI-SDK path and 404 / mismatch here).
 */
const SUGGESTIONS_MODEL = process.env.VERTEX_AI_SUGGESTIONS_MODEL ?? "gemini-2.5-flash";

interface CachedSuggestions {
  prompts: string[];
  schemaHash: string;
  generatedAtMs: number | null;
}

/**
 * How long a cached set is served before we re-check the schema. Bounds
 * the expensive BigQuery table-list (run only to detect schema drift) to
 * roughly once per workspace per day, while still picking up new
 * connectors within a day. Connector changes also invalidate via hash.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-workspace cache lives on the workspace doc under `promptSuggestions`.
 * Keyed by a hash of the table+column shape, so adding/removing a
 * connector (which changes the schema) naturally invalidates it; an
 * unchanged schema serves from cache with no LLM call.
 */
function readCache(data: unknown): CachedSuggestions | null {
  if (!data || typeof data !== "object") return null;
  const c = (data as Record<string, unknown>).promptSuggestions;
  if (!c || typeof c !== "object") return null;
  const { prompts, schemaHash, generatedAt } = c as Record<string, unknown>;
  if (
    Array.isArray(prompts) &&
    prompts.every((p) => typeof p === "string") &&
    prompts.length > 0 &&
    typeof schemaHash === "string"
  ) {
    // Firestore Timestamp → millis (best-effort; null if absent/odd shape).
    const ts = generatedAt as { toMillis?: () => number } | undefined;
    const generatedAtMs = typeof ts?.toMillis === "function" ? ts.toMillis() : null;
    return { prompts: prompts as string[], schemaHash, generatedAtMs };
  }
  return null;
}

/** Stable fingerprint of the workspace's table + column shape. */
function hashSchema(tables: WorkspaceTable[]): string {
  const normalized = tables
    .map(
      (t) =>
        `${t.qualifiedName}:${t.columns
          .map((c) => c.name)
          .sort()
          .join(",")}`
    )
    .sort()
    .join("|");
  return createHash("sha1").update(normalized).digest("hex");
}

/** Compact, token-bounded schema summary for the generation prompt. */
function summarizeSchema(tables: WorkspaceTable[]): string {
  return tables
    .slice(0, 40)
    .map((t) => {
      const cols = t.columns
        .slice(0, 24)
        .map((c) => `${c.name} ${c.type}`)
        .join(", ");
      const label = t.tableDescription ? ` — ${t.tableDescription}` : "";
      return `${t.qualifiedName}${label}\n  ${cols}`;
    })
    .join("\n");
}

function buildPrompt(schemaSummary: string, currency: string): string {
  return [
    "You write example questions for a natural-language data-analytics tool.",
    "A business user clicks one of your questions to get an instant chart or dashboard.",
    "",
    "Below is the schema of the tables THIS customer has connected. Write exactly",
    `${SUGGESTION_COUNT} short, specific questions that fit THIS data — reference real`,
    "entities/metrics implied by the tables (e.g. if there are orders/revenue, ask about",
    "revenue; if there are events/sessions, ask about engagement; if subscriptions, ask",
    "about churn/MRR). Do NOT invent metrics the schema can't support.",
    "",
    "Rules:",
    "- Each question under 12 words, phrased the way a non-technical user would ask.",
    "- Vary them: a ranking, a time-trend, a breakdown, and a dashboard request.",
    `- Assume money is in ${currency}.`,
    "- Return ONLY a JSON array of strings. No prose, no markdown, no keys.",
    "",
    "Schema:",
    schemaSummary,
  ].join("\n");
}

/** Pull the first JSON array of strings out of a model response. */
function parseSuggestions(raw: string): string[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (
      Array.isArray(parsed) &&
      parsed.every((p) => typeof p === "string" && p.trim().length > 0)
    ) {
      return parsed.map((p: string) => p.trim()).slice(0, SUGGESTION_COUNT);
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

async function generate(
  tables: WorkspaceTable[],
  region: string,
  currency: string
): Promise<string[] | null> {
  // Ensure GCP auth (WIF on Vercel) is wired before the Vertex call.
  await vertexReady(region);
  const model = buildModel(region, {}, SUGGESTIONS_MODEL);
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: buildPrompt(summarizeSchema(tables), currency) }] }],
    generationConfig: { maxOutputTokens: 320, temperature: 0.4 },
  });
  const text =
    result.response.candidates?.[0]?.content?.parts
      ?.map((p: Part) => p.text ?? "")
      .join("")
      .trim() ?? "";
  return parseSuggestions(text);
}

/**
 * Data-aware example questions for the empty chat screen. Returns cached
 * suggestions when the workspace schema is unchanged, otherwise generates
 * a fresh set with Gemini Flash and caches it. Always resolves — falls
 * back to DEFAULT_PROMPT_SUGGESTIONS for empty workspaces or on any error.
 */
export async function getPromptSuggestions(
  clientId: string,
  workspaceId: string
): Promise<string[]> {
  try {
    await dbReady();

    // 1. Fresh cache short-circuits everything — no Firestore connector
    //    read, no BigQuery table-list, no LLM call.
    const wsRef = workspaceDoc(clientId, workspaceId);
    const wsSnap = await wsRef.get();
    const cached = readCache(wsSnap.data());
    if (cached && cached.generatedAtMs && Date.now() - cached.generatedAtMs < CACHE_TTL_MS) {
      return cached.prompts;
    }

    // 2. Cache stale/absent — re-list tables to detect schema drift.
    const connSnap = await connectorsIn(clientId, workspaceId).get();
    const connectorRefs = connSnap.docs.map((d) => {
      const data = d.data() as { name?: string; type?: string };
      return { id: d.id, name: data.name, type: data.type };
    });
    if (connectorRefs.length === 0) return DEFAULT_PROMPT_SUGGESTIONS;

    const tables = await listWorkspaceTables(clientId, workspaceId, connectorRefs);
    if (tables.length === 0) return DEFAULT_PROMPT_SUGGESTIONS;

    const schemaHash = hashSchema(tables);

    // 3. Schema unchanged — keep the prompts, just bump the TTL window.
    if (cached && cached.schemaHash === schemaHash) {
      await wsRef.set(
        { promptSuggestions: { generatedAt: FieldValue.serverTimestamp() } },
        { merge: true }
      );
      return cached.prompts;
    }

    const regional = await getWorkspaceRegional(clientId, workspaceId);
    const region = vertexRegionForResidency(regional.bqLocation);
    const prompts = await generate(tables, region, regional.settings.currency);
    if (!prompts || prompts.length === 0) {
      return cached?.prompts ?? DEFAULT_PROMPT_SUGGESTIONS;
    }

    await wsRef.set(
      {
        promptSuggestions: {
          prompts,
          schemaHash,
          generatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );
    return prompts;
  } catch (err) {
    console.warn("[prompt-suggestions] generation failed, using defaults", {
      error: err instanceof Error ? err.message : String(err),
    });
    return DEFAULT_PROMPT_SUGGESTIONS;
  }
}
