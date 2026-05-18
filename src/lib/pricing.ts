/**
 * Cost-estimation rates and FX conversion for internal usage tracking.
 *
 * All rates are published Google Cloud / Anthropic list prices as of
 * 2026-05. Verify before launching paid plans — these are stored here
 * (not in env) so they're code-reviewable and versioned. If a rate
 * changes, bump it and the change shows up in PR review.
 *
 * Cloud Billing Export → BigQuery is the AUTHORITATIVE source for
 * actual costs. These estimates are used for:
 *  - Real-time UI ("today you've spent £X")
 *  - Plan-limit enforcement ("you're approaching the Pro plan cap")
 *  - Vertex AI attribution (no labels available, so we estimate)
 *
 * For monthly invoicing, reconcile against the billing export.
 */

// ── FX ─────────────────────────────────────────────────────────────
// All internal accounting is in GBP. Costs come from GCP in USD; we
// convert at write time using a static rate. For Phase 1 this is a
// constant — wire a live FX feed (e.g. exchangerate.host daily refresh
// into Firestore) when we have real customer spend to track precisely.

/** Approximate USD→GBP rate, 2026-05. Update quarterly until live feed lands. */
export const USD_TO_GBP = 0.79;

export function usdToGbp(usd: number): number {
  return usd * USD_TO_GBP;
}

// ── Vertex AI Claude ───────────────────────────────────────────────
// Per-million-token list pricing on Vertex's global endpoint (no
// regional premium). Update when Anthropic changes published rates or
// we switch model defaults.
//
// If the agent's default model changes (env var VERTEX_AI_MODEL), the
// runtime looks up the matching entry below. Unknown models fall back
// to OPUS_4_7 rates and log a warning.

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputUsdPerM: number;
  /** USD per 1M output tokens */
  outputUsdPerM: number;
}

export const VERTEX_MODEL_PRICING: Record<string, ModelPricing> = {
  // Numbers below are published list rates — verify against Anthropic's
  // pricing page before charging customers. They sit here in code so
  // any change is reviewable, not silently picked up from a Firestore
  // doc that nobody can audit.
  "claude-opus-4-7": { inputUsdPerM: 15, outputUsdPerM: 75 },
  "claude-opus-4-6": { inputUsdPerM: 15, outputUsdPerM: 75 },
  "claude-sonnet-4-6": { inputUsdPerM: 3, outputUsdPerM: 15 },
  "claude-sonnet-4-5@20250929": { inputUsdPerM: 3, outputUsdPerM: 15 },
  "claude-haiku-4-5@20251001": { inputUsdPerM: 0.25, outputUsdPerM: 1.25 },
};

export function vertexCostGbp(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const rates = VERTEX_MODEL_PRICING[model] ?? VERTEX_MODEL_PRICING["claude-opus-4-7"];
  const usd = (tokensIn / 1_000_000) * rates.inputUsdPerM
            + (tokensOut / 1_000_000) * rates.outputUsdPerM;
  return usdToGbp(usd);
}

// ── BigQuery ───────────────────────────────────────────────────────
// On-demand pricing tier. We submit jobs with `maximumBytesBilled` cap
// so this is also our customer-facing rate-limit check.

/** USD per byte scanned on-demand. $5/TiB = $5 / (1024^4). */
export const BQ_USD_PER_BYTE_SCANNED = 5 / Math.pow(1024, 4);

export function bqQueryCostGbp(bytesScanned: number): number {
  return usdToGbp(bytesScanned * BQ_USD_PER_BYTE_SCANNED);
}

// ── Cloud Run Jobs ─────────────────────────────────────────────────
// "Always-on" pricing tier (request-based pricing doesn't apply to
// Jobs since they run on a schedule, not in response to traffic).
// Rates from cloud.google.com/run/pricing 2026-05.

export const CLOUD_RUN_USD_PER_VCPU_SECOND = 0.0000240;
export const CLOUD_RUN_USD_PER_GIB_SECOND = 0.0000025;

export function cloudRunCostGbp(
  vcpuSeconds: number,
  gibSeconds: number
): number {
  const usd = vcpuSeconds * CLOUD_RUN_USD_PER_VCPU_SECOND
            + gibSeconds * CLOUD_RUN_USD_PER_GIB_SECOND;
  return usdToGbp(usd);
}
