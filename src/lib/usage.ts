import { bqReady } from "@/lib/bigquery";
import {
  bqQueryCostGbp,
  cloudRunCostGbp,
  vertexCostGbp,
} from "@/lib/pricing";

/**
 * Internal usage event stream. Every billable operation lands here via
 * fire-and-forget streaming insert. Lives in liveli-496609.liveli_internal
 * (NOT a customer dataset). Owned by us, never visible to customers.
 *
 * This is the LIVE source of truth for the in-app billing UI ("today
 * you've used £X"). For monthly invoicing, reconcile against the Cloud
 * Billing Export → BQ dataset which has Google's authoritative figures.
 *
 * Insert failure is logged but never throws — billing data being lossy
 * is a worse failure mode than dropping a user request. Worst case, a
 * single missed event under-counts spend; cost reconciliation against
 * the billing export still catches it monthly.
 */

const INTERNAL_DATASET = "liveli_internal";
const EVENTS_TABLE = "usage_events";

export type UsageEventType =
  | "query.run"
  | "agent.message"
  | "agent.metadata"
  | "sync.run"
  | "chart.create"
  | "dashboard.create"
  | "dashboard.view"
  | "workspace.create"
  | "connector.create"
  | "connector.delete"
  | "connector.pause"
  | "connector.resume"
  | "connector.full_refresh"
  | "model.train"
  | "forecast.run"
  | "anomaly.detect";

export interface UsageEventBase {
  clientId: string;
  workspaceId?: string;
  userId?: string;
  eventType: UsageEventType;
  /** Free-form identifier of the touched resource (connectorId, chatId, dashboardId, etc.). */
  resource?: string;
  /** Anything that doesn't fit a typed column. Use sparingly. */
  labels?: Record<string, string | number | boolean>;
}

interface UsageEventRow extends UsageEventBase {
  ts: string;
  bytesScanned?: number;
  executionMs?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost_gbp_estimate?: number;
}

/**
 * Low-level: write a fully-specified row. Most callers should use the
 * typed helpers below instead (logQueryRun, logAgentMessage, etc.) so
 * cost estimation is centralised here.
 */
export function logUsageEvent(event: UsageEventBase & Partial<UsageEventRow>): void {
  const row: UsageEventRow = {
    ts: new Date().toISOString(),
    ...event,
  };
  // Fire-and-forget. Never block user requests on logging.
  insert(row).catch((err) => {
    // BigQuery streaming-insert failures arrive as PartialFailureError
    // with err.errors[] containing per-row reasons. The raw `err.message`
    // just says "An API error has occurred" — useless without the inner
    // detail. Walk own properties to capture the full failure shape.
    const props: Record<string, unknown> = {};
    if (err && typeof err === "object") {
      for (const key of Object.getOwnPropertyNames(err)) {
        try {
          const v = (err as Record<string, unknown>)[key];
          if (typeof v !== "function") props[key] = v;
        } catch {
          /* unreadable */
        }
      }
    }
    console.error("[usage] insert failed", {
      eventType: row.eventType,
      clientId: row.clientId,
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : typeof err,
      props,
    });
  });
}

async function insert(row: UsageEventRow): Promise<void> {
  const bq = await bqReady();

  // Massage the row before streaming insert:
  //  1. JSON columns need a serialized string, NOT a JS object. The
  //     Node SDK auto-handles STRUCT/RECORD but NOT JSON. Without this
  //     the insert fails with "Could not parse '[object Object]' as
  //     valid JSON for field labels".
  //  2. Drop undefined fields — BQ schemas accept missing keys but
  //     can reject `undefined` (it serialises to literal "null" in
  //     odd ways depending on the SDK version).
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    if (key === "labels" && value !== null) {
      cleaned[key] = typeof value === "string" ? value : JSON.stringify(value);
    } else {
      cleaned[key] = value;
    }
  }

  await bq
    .dataset(INTERNAL_DATASET)
    .table(EVENTS_TABLE)
    .insert([cleaned], {
      // Defensive: if we add a new field but the table hasn't been
      // migrated yet, skip-the-row-and-log rather than fail the call.
      ignoreUnknownValues: true,
      // Same goes for nullable mismatches.
      skipInvalidRows: false,
    });
}

// ── Typed helpers — preferred call sites ───────────────────────────

export function logQueryRun(input: {
  clientId: string;
  workspaceId: string;
  userId?: string;
  bytesScanned: number;
  executionMs: number;
  connectorId?: string;
}): void {
  logUsageEvent({
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    eventType: "query.run",
    resource: input.connectorId,
    bytesScanned: input.bytesScanned,
    executionMs: input.executionMs,
    cost_gbp_estimate: bqQueryCostGbp(input.bytesScanned),
  });
}

export function logAgentMessage(input: {
  clientId: string;
  workspaceId: string;
  userId?: string;
  chatId?: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  executionMs: number;
}): void {
  logUsageEvent({
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    eventType: "agent.message",
    resource: input.chatId,
    executionMs: input.executionMs,
    model: input.model,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    cost_gbp_estimate: vertexCostGbp(input.model, input.tokensIn, input.tokensOut),
  });
}

/**
 * Token + duration usage from a single metadata-enrichment-agent run.
 * Distinct event type from `agent.message` so the cost dashboard can
 * attribute metadata-pipeline spend separately from user-facing chat.
 * Resource is the connectorId — every metadata run is scoped to one.
 */
export function logMetadataAgentRun(input: {
  clientId: string;
  workspaceId: string;
  connectorId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  executionMs: number;
  toolCallsUsed: number;
  status: "finished" | "max-turns" | "error";
}): void {
  logUsageEvent({
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    eventType: "agent.metadata",
    resource: input.connectorId,
    executionMs: input.executionMs,
    model: input.model,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    cost_gbp_estimate: vertexCostGbp(input.model, input.tokensIn, input.tokensOut),
    labels: {
      toolCallsUsed: input.toolCallsUsed,
      status: input.status,
    },
  });
}

/**
 * BigQuery ML operations: model training, forecasting, anomaly detection.
 * All are billed by bytes processed (same on-demand rate as a query), so
 * the GBP estimate reuses bqQueryCostGbp. NOTE: BQML CREATE MODEL can bill
 * differently from a plain SELECT in some tiers — treat this as an estimate
 * and reconcile against the Cloud Billing Export for invoicing, exactly as
 * the file header describes.
 */
export function logBqmlUsage(input: {
  eventType: "model.train" | "forecast.run" | "anomaly.detect";
  clientId: string;
  workspaceId: string;
  userId?: string;
  /** Model identifier the op touched. */
  resource?: string;
  bytesScanned: number;
  executionMs: number;
}): void {
  logUsageEvent({
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    eventType: input.eventType,
    resource: input.resource,
    bytesScanned: input.bytesScanned,
    executionMs: input.executionMs,
    cost_gbp_estimate: bqQueryCostGbp(input.bytesScanned),
  });
}

export function logSyncRun(input: {
  clientId: string;
  workspaceId: string;
  userId?: string;
  connectorId: string;
  executionMs: number;
  vcpuSeconds: number;
  gibSeconds: number;
  succeeded: boolean;
}): void {
  logUsageEvent({
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    eventType: "sync.run",
    resource: input.connectorId,
    executionMs: input.executionMs,
    cost_gbp_estimate: cloudRunCostGbp(input.vcpuSeconds, input.gibSeconds),
    labels: { succeeded: input.succeeded },
  });
}
