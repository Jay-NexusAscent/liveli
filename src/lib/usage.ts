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
  | "sync.run"
  | "chart.create"
  | "dashboard.create"
  | "dashboard.view"
  | "workspace.create"
  | "connector.create"
  | "connector.delete";

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
    // eslint-disable-next-line no-console
    console.error("[usage] insert failed", {
      eventType: row.eventType,
      clientId: row.clientId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

async function insert(row: UsageEventRow): Promise<void> {
  const bq = await bqReady();
  await bq.dataset(INTERNAL_DATASET).table(EVENTS_TABLE).insert([row]);
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
