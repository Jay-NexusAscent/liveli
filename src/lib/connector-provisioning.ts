import { FieldValue } from "@google-cloud/firestore";
import {
  bqReady,
  connectorDatasetId,
  DEFAULT_BQ_LOCATION,
} from "@/lib/bigquery";
import { upsertSyncJob } from "@/lib/cloud-scheduler";
import type { WorkspaceContext } from "@/lib/clients";
import { connectorsIn, dbReady, workspaceDoc } from "@/lib/firestore";
import { cloudComputeRegionForResidency, gcp } from "@/lib/gcp";
import { storeConnectorSecret } from "@/lib/secret-manager";
import { logUsageEvent } from "@/lib/usage";

export type SyncFrequency = "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";

export interface ProvisionConnectorInput {
  /** Connector type identifier — matches the Cloud Run Job naming
   * (`connector-<type>-to-bq`) and the sync/scheduled-sync env-mapping
   * switch. Snake-case lowercase. */
  type: string;
  /** Friendly name shown in the UI. */
  name: string;
  /** Workspace tenant context — comes from requireWorkspaceContext(). */
  ctx: WorkspaceContext;
  /**
   * Credentials to seal into Secret Manager. All values must be strings
   * because Secret Manager payloads are byte blobs and we serialise the
   * whole object as JSON. The shape is read back verbatim by the sync /
   * scheduled-sync route's per-type env-mapping branch, so keep it in
   * sync with what that branch destructures.
   */
  secretPayload: Record<string, string>;
  /**
   * Non-sensitive connector metadata to merge into the Firestore
   * connector doc alongside the canonical fields this helper writes
   * (type, name, status, bqDataset, etc.). Use this for display fields
   * the Connections page or the edit modal needs (e.g. host for a DB
   * connector, store handle for Shopify) — never for credentials.
   */
  firestoreFields: Record<string, unknown>;
  /** Cron cadence — must match Cloud Scheduler's accepted values. */
  syncFrequency: SyncFrequency;
}

export interface ProvisionConnectorResult {
  connectorId: string;
  bqDataset: string;
  bqLocation: "EU" | "US";
}

/**
 * End-to-end provisioning of a connector record:
 *   1. Resolve the workspace's BQ location (per-workspace, immutable).
 *   2. Create a per-connector BigQuery dataset, labelled for billing
 *      attribution by customer / workspace / connector / type.
 *   3. Seal credentials into Secret Manager under a tenant-scoped name.
 *   4. Write the Firestore connector doc.
 *   5. Upsert the Cloud Scheduler job for recurring syncs.
 *   6. Log a usage event.
 *
 * Scheduler upsert is a soft-failure: if Cloud Scheduler is misconfigured
 * the connector still saves (manual "Sync now" continues to work) and the
 * error is logged. Everything else is hard-failure — partial state from
 * a failed dataset.create or secret.store should be visible immediately
 * so it can be cleaned up.
 *
 * IDEMPOTENT IT IS NOT — call this once per connector. The connect route
 * is the only intended caller.
 */
export async function provisionConnector(
  input: ProvisionConnectorInput
): Promise<ProvisionConnectorResult> {
  const { type, name, ctx, secretPayload, firestoreFields, syncFrequency } = input;

  await dbReady();

  const connectorRef = connectorsIn(ctx.clientId, ctx.workspaceId).doc();
  const connectorId = connectorRef.id;

  // Workspace BQ location is set at workspace creation, immutable
  // afterwards. We honour it so connector data lives in the same
  // multi-region as the rest of the customer's warehouse.
  const wsSnap = await workspaceDoc(ctx.clientId, ctx.workspaceId).get();
  const wsData = wsSnap.data() as { bqLocation?: "EU" | "US" } | undefined;
  const bqLocation = wsData?.bqLocation ?? DEFAULT_BQ_LOCATION;

  const bq = await bqReady();
  const datasetId = connectorDatasetId(ctx.clientId, ctx.workspaceId, connectorId);

  // Labels feed Cloud Billing Export — they let us attribute storage +
  // query costs back to a specific (customer, workspace, connector, type)
  // tuple later. BQ label values must be lowercase alnum/underscore.
  await bq.dataset(datasetId).create({
    location: bqLocation,
    labels: {
      customer: ctx.clientId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase(),
      workspace: ctx.workspaceId.toLowerCase(),
      connector: connectorId.toLowerCase(),
      type,
    },
  });

  const secretRef = await storeConnectorSecret(
    ctx.clientId,
    connectorId,
    secretPayload
  );

  await connectorRef.set({
    type,
    name,
    status: "configured",
    syncFrequency,
    secretRef,
    createdBy: ctx.userId,
    createdAt: FieldValue.serverTimestamp(),
    bqProject: gcp.projectId,
    bqDataset: datasetId,
    bqLocation,
    ...firestoreFields,
  });

  // Best-effort. The connector is functional without the recurring
  // scheduler (manual sync still works), so don't block the save on
  // Cloud Scheduler hiccups — but do log them.
  try {
    const { region: schedulerRegion } = cloudComputeRegionForResidency(bqLocation);
    await upsertSyncJob({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      connectorId,
      syncFrequency,
      region: schedulerRegion,
    });
  } catch (err) {
    console.error("[provisionConnector] upsertSyncJob failed", {
      connectorId,
      type,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  logUsageEvent({
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    eventType: "connector.create",
    resource: connectorId,
    labels: { type, syncFrequency },
  });

  return { connectorId, bqDataset: datasetId, bqLocation };
}

/**
 * Build the structured error envelope the connect routes return on
 * failure. Mirrors the format the postgres route established: `error`
 * is the high-level "what step failed", `errorMessage` is the technical
 * underlying message, `errorProps` captures any other enumerable fields
 * on the thrown value. The wizards key off `error` + `errorMessage`.
 */
export function connectErrorEnvelope(
  type: string,
  step: string,
  err: unknown
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (err && typeof err === "object") {
    for (const key of Object.getOwnPropertyNames(err)) {
      try {
        const v = (err as Record<string, unknown>)[key];
        props[key] = typeof v === "function" ? "[function]" : v;
      } catch {
        props[key] = "[unreadable]";
      }
    }
  }
  return {
    error: `${type}/connect failed at step "${step}"`,
    errorType:
      (err as { constructor?: { name?: string } })?.constructor?.name ??
      typeof err,
    errorString: String(err),
    errorMessage: (err as { message?: string })?.message ?? String(err),
    errorProps: props,
  };
}
