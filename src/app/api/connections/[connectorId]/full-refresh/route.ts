import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady, workspaceDoc } from "@/lib/firestore";
import { bqReady, DEFAULT_BQ_LOCATION } from "@/lib/bigquery";
import { readConnectorSecret } from "@/lib/secret-manager";
import { runConnectorJob } from "@/lib/cloud-run";
import { cloudComputeRegionForResidency, gcp } from "@/lib/gcp";
import { buildTapEnv, UnsupportedConnectorTypeError } from "@/lib/connector-env";
import { logUsageEvent } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Full refresh of a connector — drops the BigQuery dataset (wiping all
 * replicated tables) and triggers a fresh sync that rebuilds from the
 * source. Use cases:
 *   - Customer changed the source schema (dropped/renamed tables or
 *     columns); incremental sync would leave stale residue in BQ.
 *   - Suspected corruption / failed partial sync left BQ in an
 *     inconsistent state.
 *   - Customer just wants to be sure they're seeing the source-of-truth
 *     in BQ without poking at internals.
 *
 * Sequence:
 *   1. Drop the connector's BQ dataset (force=true cascades to tables).
 *   2. Re-create the dataset with the same name + location + labels
 *      so cost-attribution stays correct.
 *   3. Trigger the Cloud Run Job. Meltano state in the container is
 *      ephemeral, so without explicit state-id reuse from a backend
 *      the sync is naturally a full extract — and the just-emptied
 *      dataset means there's nothing left to deduplicate against.
 *   4. Mark Firestore status=syncing, clear any lastError.
 *
 * Side effect: any chats/dashboards that reference tables in this
 * connector's dataset will return "table not found" until the resync
 * completes. We don't block those queries — the customer triggered
 * this knowingly via a confirm dialog.
 *
 * NOTE: this duplicates a small chunk of /sync/route.ts's env-building
 * logic. When that route is next touched it should be extracted into
 * a triggerConnectorSync(ctx, connectorId) helper that both routes
 * can call. Doing the extraction in this PR would balloon scope.
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const { connectorId } = await context.params;
  const step = { current: "init" };

  try {
    step.current = "dbReady";
    await dbReady();

    step.current = "load connector doc";
    const ref = connectorsIn(ctx.clientId, ctx.workspaceId).doc(connectorId);
    const snap = await ref.get();
    if (!snap.exists) {
      return Response.json({ error: "Connector not found" }, { status: 404 });
    }
    const data = snap.data() as {
      type: string;
      bqDataset?: string;
      bqLocation?: "EU" | "US";
    };

    if (!data.bqDataset) {
      return Response.json(
        { error: "Connector has no BigQuery dataset to refresh." },
        { status: 400 }
      );
    }

    // Workspace-default BQ location as fallback if the connector doc
    // somehow lacks one (older connectors that pre-dated the field).
    let location: "EU" | "US" = data.bqLocation ?? DEFAULT_BQ_LOCATION;
    if (!data.bqLocation) {
      const wsSnap = await workspaceDoc(ctx.clientId, ctx.workspaceId).get();
      const wsLoc = (wsSnap.data() as { bqLocation?: "EU" | "US" })?.bqLocation;
      location = wsLoc ?? location;
    }

    // ── 1. Drop the dataset (idempotent — NOT_FOUND treated as already-gone) ──
    step.current = `drop dataset (${data.bqDataset})`;
    const bq = await bqReady();
    try {
      await bq.dataset(data.bqDataset).delete({ force: true });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 404) throw err;
    }

    // ── 2. Re-create the dataset with the same labels + location ───
    // Labels match what /api/connections/<type>/connect/route.ts wrote
    // — keep them consistent so Cloud Billing Export attribution doesn't
    // skip a beat across the refresh.
    step.current = `recreate dataset (${data.bqDataset}, location=${location})`;
    await bq.dataset(data.bqDataset).create({
      location,
      labels: {
        customer: ctx.clientId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase(),
        workspace: ctx.workspaceId.toLowerCase(),
        connector: connectorId.toLowerCase(),
        type: data.type,
      },
    });

    // ── 3. Trigger the Cloud Run Job (same logic as /sync) ─────────
    // Regional routing: EU residency → europe-west1, US → us-central1.
    // Job names take the matching `-eu` / `-us` suffix; Terraform
    // declares both copies in infra/cloud-run.tf.
    step.current = "build sync env";
    const { region, suffix } = cloudComputeRegionForResidency(location);
    const creds = await readConnectorSecret(ctx.clientId, connectorId);
    const jobName = `connector-${data.type}-to-bq-${suffix}`;
    const env: Record<string, string> = {
      WORKSPACE_ID: ctx.clientId, // legacy var name in the connector image
      CLIENT_ID: ctx.clientId,
      LIVELI_WORKSPACE_ID: ctx.workspaceId,
      CONNECTOR_ID: connectorId,
      TARGET_BIGQUERY_PROJECT: gcp.projectId,
      TARGET_BIGQUERY_DATASET: data.bqDataset,
      TARGET_BIGQUERY_LOCATION: location,
    };
    try {
      Object.assign(env, buildTapEnv(data.type, creds));
    } catch (err) {
      if (err instanceof UnsupportedConnectorTypeError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    step.current = "runConnectorJob";
    const { executionName } = await runConnectorJob(jobName, region, env);

    // ── 4. Firestore status update ─────────────────────────────────
    await ref.update({
      status: "syncing",
      lastExecutionName: executionName,
      lastSyncAttemptAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
      lastErrorDiagnosticMessage: FieldValue.delete(),
      lastFreshRefreshAt: FieldValue.serverTimestamp(),
    });

    logUsageEvent({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      eventType: "connector.full_refresh",
      resource: connectorId,
      labels: { type: data.type },
    });

    return Response.json({ ok: true, executionName });
  } catch (err) {
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
    const responseBody = {
      error: `full-refresh failed at step "${step.current}"`,
      errorMessage: (err as { message?: string })?.message ?? String(err),
      errorProps: props,
    };
    console.error("[full-refresh]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
