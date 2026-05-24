import { FieldValue } from "@google-cloud/firestore";
import {
  bqReady,
  connectorDatasetId,
  DEFAULT_BQ_LOCATION,
} from "@/lib/bigquery";
import { deleteSyncJob, upsertSyncJob } from "@/lib/cloud-scheduler";
import type { WorkspaceContext } from "@/lib/clients";
import { connectorsIn, dbReady, workspaceDoc } from "@/lib/firestore";
import { cloudComputeRegionForResidency, gcp } from "@/lib/gcp";
import { deleteConnectorSecret, storeConnectorSecret } from "@/lib/secret-manager";
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
 * End-to-end provisioning of a connector record with compensating
 * cleanup on partial failure.
 *
 *   1. Resolve the workspace's BQ location (per-workspace, immutable).
 *   2. Create a per-connector BigQuery dataset, labelled for billing
 *      attribution by customer / workspace / connector / type.
 *   3. Seal credentials into Secret Manager under a tenant-scoped name.
 *   4. Write the Firestore connector doc.
 *   5. Upsert the Cloud Scheduler job for recurring syncs.
 *   6. Log a usage event.
 *
 * **Compensating cleanup (LIVELI-79 / LIVELI-119).** If any of steps
 * 2-5 throws, the resources created before that point are unwound in
 * reverse order:
 *   - delete scheduler job (if created)
 *   - delete Firestore connector doc
 *   - delete Secret Manager secret
 *   - delete BigQuery dataset (404-tolerant)
 *
 * Each cleanup step has its own try/catch so a failure on one doesn't
 * stop the rest. Cleanup failures are logged but never re-thrown — the
 * original error wins, and the caller surfaces it via
 * `connectErrorEnvelope` below.
 *
 * Scheduler upsert (step 5) is a soft-failure on the forward path: a
 * misconfigured Scheduler doesn't fail the connector save (manual
 * "Sync now" still works without recurring). The reverse path tracks
 * the scheduler region only when the upsert succeeded — if it never
 * created the job, there's nothing to clean up.
 *
 * IDEMPOTENT IT IS NOT — call this once per connector. The connect
 * route is the only intended caller.
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

  // Resource tracker for compensating cleanup. Each entry stays falsy
  // until the corresponding resource has been created successfully.
  // The catch block reads these and unwinds in reverse order.
  let createdBqDataset: string | null = null;
  let createdSecret = false;
  let createdFirestoreDoc = false;
  let createdSchedulerRegion: string | null = null;

  try {
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
    createdBqDataset = datasetId;

    const secretRef = await storeConnectorSecret(
      ctx.clientId,
      connectorId,
      secretPayload
    );
    createdSecret = true;

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
    createdFirestoreDoc = true;

    // Soft-failure on the forward path. The connector is functional
    // without the recurring scheduler (manual "Sync now" still works)
    // so don't block the save on Cloud Scheduler hiccups — but track
    // whether the upsert succeeded so the cleanup path knows whether
    // a scheduler job needs to be torn down.
    try {
      const { region: schedulerRegion } = cloudComputeRegionForResidency(bqLocation);
      await upsertSyncJob({
        clientId: ctx.clientId,
        workspaceId: ctx.workspaceId,
        connectorId,
        syncFrequency,
        region: schedulerRegion,
      });
      createdSchedulerRegion = schedulerRegion;
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
  } catch (err) {
    // ── Compensating cleanup (reverse order) ─────────────────────
    // Each step is independently try/catched so one failure doesn't
    // prevent the others. Failures are logged but never re-thrown —
    // the original error wins, and the caller surfaces it.
    const cleanupErrors: string[] = [];

    if (createdSchedulerRegion) {
      try {
        await deleteSyncJob(ctx.clientId, connectorId, createdSchedulerRegion);
      } catch (cleanupErr) {
        cleanupErrors.push(
          `scheduler: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
      }
    }

    if (createdFirestoreDoc) {
      try {
        await connectorRef.delete();
      } catch (cleanupErr) {
        cleanupErrors.push(
          `firestore: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
      }
    }

    if (createdSecret) {
      try {
        await deleteConnectorSecret(ctx.clientId, connectorId);
      } catch (cleanupErr) {
        cleanupErrors.push(
          `secret: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
      }
    }

    if (createdBqDataset) {
      try {
        await bq.dataset(createdBqDataset).delete({ force: true });
      } catch (cleanupErr) {
        // 404 means the dataset never finished creating — already in
        // the desired "absent" state, so not really a cleanup failure.
        const code = (cleanupErr as { code?: number })?.code;
        if (code !== 404) {
          cleanupErrors.push(
            `bq: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
          );
        }
      }
    }

    if (cleanupErrors.length > 0) {
      console.error("[provisionConnector] compensating cleanup had failures", {
        clientId: ctx.clientId,
        type,
        connectorId,
        cleanupErrors,
      });
    }

    throw err;
  }
}

/**
 * Sensitive-key regex used to redact property names that smell like
 * credentials, regardless of value. Catches things like `Authorization`
 * headers and `client_secret` fields that GCP SDK errors sometimes
 * attach to `.config` / `.request`.
 */
const SENSITIVE_KEYS = /password|secret|token|credential|api[_-]?key|authorization/i;

/**
 * Build the structured error envelope the connect routes return on
 * failure. `error` is the high-level "what step failed", `errorMessage`
 * is the technical underlying message, `errorProps` captures any other
 * enumerable fields on the thrown value. The wizards key off `error` +
 * `errorMessage`.
 *
 * **Secret sanitisation (LIVELI-119).** Both checks run together:
 *
 *   1. Any property whose KEY matches `SENSITIVE_KEYS` is replaced
 *      with `[redacted]` — catches cases where GCP SDK errors attach
 *      payload-shaped objects to fields like `.config.headers`.
 *   2. Any string in the output matching one of `sensitiveValues`
 *      (the actual secret strings from the user's request body) is
 *      replaced with `[redacted]` — catches cases where the value
 *      ends up in `errorString` / `errorMessage` via stringification.
 *
 * Callers MUST pass the request's sensitive values via
 * `sensitiveValues` — otherwise the value-based check is a no-op and
 * a user's password could end up in the response body if the SDK
 * stringified it into an error message somewhere.
 */
export function connectErrorEnvelope(
  type: string,
  step: string,
  err: unknown,
  sensitiveValues: string[] = []
): Record<string, unknown> {
  const sanitiseString = (s: string): string => {
    let out = s;
    for (const sv of sensitiveValues) {
      if (sv && out.includes(sv)) out = out.split(sv).join("[redacted]");
    }
    return out;
  };

  const sanitiseValue = (val: unknown): unknown => {
    if (typeof val === "string") return sanitiseString(val);
    return val;
  };

  const props: Record<string, unknown> = {};
  if (err && typeof err === "object") {
    for (const key of Object.getOwnPropertyNames(err)) {
      if (SENSITIVE_KEYS.test(key)) {
        props[key] = "[redacted]";
        continue;
      }
      try {
        const v = (err as Record<string, unknown>)[key];
        if (typeof v === "function") {
          props[key] = "[function]";
        } else if (typeof v === "object" && v !== null) {
          // Shallow-deep walk via JSON.stringify with a replacer that
          // applies BOTH redactions at any depth. Most SDK errors aren't
          // deeper than 2-3 levels; we don't want to follow circular refs.
          props[key] = JSON.parse(
            JSON.stringify(v, (k, x) => {
              if (typeof k === "string" && SENSITIVE_KEYS.test(k)) return "[redacted]";
              return sanitiseValue(x);
            })
          );
        } else {
          props[key] = sanitiseValue(v);
        }
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
    errorString: sanitiseString(String(err)),
    errorMessage: sanitiseString(
      (err as { message?: string })?.message ?? String(err)
    ),
    errorProps: props,
  };
}
