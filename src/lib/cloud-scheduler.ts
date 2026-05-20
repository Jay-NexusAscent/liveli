import { CloudSchedulerClient } from "@google-cloud/scheduler";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _client: CloudSchedulerClient | null = null;

/**
 * Cloud Scheduler controls per-connector recurring sync triggers.
 *
 * Each connector that's configured with a syncFrequency gets a Scheduler
 * job whose HTTP target hits our /api/connections/[id]/scheduled-sync
 * route. The job's body carries clientId + workspaceId so the endpoint
 * knows the tenant context without re-authenticating a user.
 *
 * Auth: Cloud Scheduler signs each request with an OIDC token from
 * the runtime SA (LIVELI_SCHEDULER_SA_EMAIL). The receiving endpoint
 * verifies the token's audience + email before triggering the sync.
 *
 * Lifecycle:
 *   - On connector create:  createOrUpdateSyncJob (idempotent)
 *   - On frequency change:  createOrUpdateSyncJob (same fn — upserts)
 *   - On connector delete:  deleteSyncJob (NOT_FOUND treated as OK)
 *
 * Failures here are LOGGED, NOT THROWN — we never block a user's
 * connector create/update/delete on Scheduler hiccups. A connector
 * without a Scheduler job still works via manual "Sync now" — the
 * scheduled trigger is the only thing that's missing.
 */

/**
 * Legacy region the FIRST iteration of the Scheduler integration wrote
 * jobs to. New jobs route per-workspace via cloudComputeRegionForResidency
 * (europe-west1 for EU, us-central1 for US), but jobs created before that
 * change still exist in europe-west4. On every upsert/delete we issue a
 * best-effort delete in this legacy region so customers self-migrate as
 * they save changes; once all pre-existing jobs have been touched, this
 * constant + the cleanup can be removed.
 */
const LEGACY_REGION = "europe-west4";

// ── Tolerant error matchers ────────────────────────────────────────
//
// The Cloud Scheduler client runs in REST fallback mode (see `scheduler()`
// below — required because Vercel's serverless runtime can't reliably
// establish HTTP/2 to GCP for gRPC). In REST mode, the gax library
// normalises errors INCONSISTENTLY across versions: sometimes `err.code`
// holds the gRPC code (number 5 for NOT_FOUND), sometimes the HTTP
// status (number 404), occasionally the code as a string ("5"). The
// original strict checks (`if (code === 5)`) silently misfired when
// gax surfaced a different shape — the pause route would catch a real
// NOT_FOUND but the `=== 5` strict-equality test would fail, the
// catch block would re-throw, and the route would return 500 even
// though the underlying server-side state was fine (job either gone
// or successfully paused). Symptom in production: clicking Pause
// produced "Couldn't pause" in the UI even when Cloud Scheduler
// audit logs showed the API call succeeded.
//
// These helpers accept every shape gax has been observed to emit
// and also fall back to a string-match on the error message. Slightly
// looser than "exactly the gRPC code" but the cost is wrong: a real
// non-NOT_FOUND error that happens to contain "not found" in its
// message would silently no-op. Acceptable trade-off given the
// scheduler operations here are intrinsically idempotent — pause /
// resume / delete of a job that doesn't exist (or is already in the
// target state) is the desired no-op behaviour regardless.

function isNotFoundError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 5 || code === "5" || code === 404 || code === "404") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /not\s*found/i.test(message);
}

function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 6 || code === "6" || code === 409 || code === "409") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /already\s*exists/i.test(message);
}

function isAlreadyInTargetStateError(err: unknown): boolean {
  // FAILED_PRECONDITION (gRPC 9 / HTTP 400 with specific reason) is what
  // Cloud Scheduler returns when you pause an already-PAUSED job or
  // resume an already-ENABLED one. Treating it as idempotent success
  // is the whole point of the pause/resume helpers.
  const code = (err as { code?: unknown })?.code;
  if (code === 9 || code === "9" || code === 412 || code === "412") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /failed[\s_]?precondition|already (paused|enabled|resumed|exists|in target state)/i.test(
    message
  );
}

async function scheduler(): Promise<CloudSchedulerClient> {
  await ensureGcpAuth();
  if (_client) return _client;
  // fallback:'rest' — same Vercel/serverless gRPC issue as Firestore,
  // Secret Manager, Cloud Run.
  _client = new CloudSchedulerClient({ fallback: "rest" });
  return _client;
}

export type SyncFrequency = "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "24h";

function slug(s: string): string {
  // Cloud Scheduler job names: [a-zA-Z0-9_-], max 500 chars.
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

export function syncJobName(clientId: string, connectorId: string): string {
  return `liveli-sync-${slug(clientId)}-${slug(connectorId)}`;
}

function jobResourceName(
  region: string,
  clientId: string,
  connectorId: string
): string {
  return `projects/${gcp.projectId}/locations/${region}/jobs/${syncJobName(clientId, connectorId)}`;
}

export function cronFromFrequency(freq: SyncFrequency): string {
  switch (freq) {
    case "5m": return "*/5 * * * *";
    case "15m": return "*/15 * * * *";
    case "30m": return "*/30 * * * *";
    case "1h": return "0 * * * *";
    case "6h": return "0 */6 * * *";
    case "12h": return "0 */12 * * *";
    case "24h": return "0 2 * * *"; // 02:00 UTC daily — off-peak.
  }
}

interface UpsertArgs {
  clientId: string;
  workspaceId: string;
  connectorId: string;
  syncFrequency: SyncFrequency;
  /**
   * Region the Scheduler job should live in — must come from
   * cloudComputeRegionForResidency(workspace.bqLocation). EU workspaces
   * get europe-west1; US workspaces get us-central1. This keeps the
   * Scheduler job in the same residency footprint as the Cloud Run Job
   * it triggers.
   */
  region: string;
}

/**
 * Resolve the target URL we want Scheduler to hit. Order of precedence:
 *   1. LIVELI_SCHEDULER_TARGET_URL (explicit override)
 *   2. NEXT_PUBLIC_APP_URL (set in env.example)
 *   3. https://app.liveli.co.uk
 * The path-portion of the URL is appended at call-site, so this is
 * the BASE only.
 */
function targetBaseUrl(): string {
  const explicit = process.env.LIVELI_SCHEDULER_TARGET_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const pub = process.env.NEXT_PUBLIC_APP_URL;
  if (pub) return pub.replace(/\/$/, "");
  return "https://app.liveli.co.uk";
}

/**
 * Service account email Cloud Scheduler will sign OIDC tokens with.
 * Set via LIVELI_SCHEDULER_SA_EMAIL. Falls back to the runtime SA.
 */
function schedulerSaEmail(): string {
  return (
    process.env.LIVELI_SCHEDULER_SA_EMAIL ||
    `liveli-runtime@${gcp.projectId}.iam.gserviceaccount.com`
  );
}

/**
 * Create or update the Scheduler job for one connector. Idempotent —
 * call freely on every connect/update/sync-frequency-change.
 */
export async function upsertSyncJob(args: UpsertArgs): Promise<void> {
  const client = await scheduler();

  // Drain any legacy job in europe-west4 — see LEGACY_REGION comment. The
  // delete is best-effort and is intentionally not the same code path as
  // a region-change delete, because the user's residency isn't changing,
  // only our implementation. NOT_FOUND is the happy path here.
  if (args.region !== LEGACY_REGION) {
    try {
      await client.deleteJob({
        name: jobResourceName(LEGACY_REGION, args.clientId, args.connectorId),
      });
    } catch (err) {
      if (!isNotFoundError(err)) {
        console.warn("[scheduler] legacy-region cleanup delete failed", {
          connectorId: args.connectorId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const parent = `projects/${gcp.projectId}/locations/${args.region}`;
  const name = jobResourceName(args.region, args.clientId, args.connectorId);
  const targetUrl = `${targetBaseUrl()}/api/connections/${args.connectorId}/scheduled-sync`;

  const job = {
    name,
    schedule: cronFromFrequency(args.syncFrequency),
    timeZone: "UTC",
    description: `Liveli scheduled sync for connector ${args.connectorId} (client ${args.clientId}).`,
    httpTarget: {
      uri: targetUrl,
      httpMethod: 1 as const, // POST
      body: Buffer.from(
        JSON.stringify({
          clientId: args.clientId,
          workspaceId: args.workspaceId,
        })
      ),
      headers: { "Content-Type": "application/json" },
      oidcToken: {
        serviceAccountEmail: schedulerSaEmail(),
        audience: targetUrl,
      },
    },
  };

  try {
    await client.createJob({ parent, job });
  } catch (err) {
    // ALREADY_EXISTS — switch to updateJob with full mask.
    if (isAlreadyExistsError(err)) {
      try {
        await client.updateJob({ job });
      } catch (updateErr) {
        console.error("[scheduler] updateJob failed", {
          name,
          err: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
      return;
    }
    console.error("[scheduler] createJob failed", {
      name,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete the Scheduler job for a connector. Idempotent — NOT_FOUND is
 * treated as already-deleted. Errors are logged but never thrown — a
 * leftover Scheduler job after a Firestore delete is annoying but not
 * dangerous (the scheduled HTTP target will 404 when our route reads
 * the missing connector doc and returns).
 */
export async function deleteSyncJob(
  clientId: string,
  connectorId: string,
  region: string
): Promise<void> {
  const client = await scheduler();

  // On delete, try BOTH the current-region job AND the legacy europe-west4
  // job. A connector created before regional routing existed has a job in
  // europe-west4 only; one created after has a job in the workspace's
  // residency region. We don't know which without an extra lookup, and
  // both deletes are cheap + idempotent.
  const targets =
    region === LEGACY_REGION ? [region] : [region, LEGACY_REGION];

  for (const r of targets) {
    const name = jobResourceName(r, clientId, connectorId);
    try {
      await client.deleteJob({ name });
    } catch (err) {
      if (isNotFoundError(err)) continue; // NOT_FOUND in this region — fine.
      console.error("[scheduler] deleteJob failed", {
        name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Pause the Scheduler job — the job stays in the system with all its
 * config intact (schedule, audience, body, OIDC token settings) but
 * does not fire. Calling resumeSyncJob flips it back on.
 *
 * In-flight Cloud Run Job executions started by previous fires
 * continue to completion — pause only affects future invocations.
 *
 * Idempotent — NOT_FOUND is treated as already-deleted (caller should
 * have handled deletion via deleteSyncJob; we no-op here so callers
 * don't have to special-case the race).
 */
export async function pauseSyncJob(
  clientId: string,
  connectorId: string,
  region: string
): Promise<void> {
  const client = await scheduler();

  // Mirror deleteSyncJob's dual-region behaviour. A connector created
  // before regional routing landed has its Scheduler job in europe-west4
  // (LEGACY_REGION); newer connectors have it in their workspace's
  // residency region. Without an extra Firestore lookup we don't know
  // which, and both pause attempts are cheap + idempotent.
  const targets =
    region === LEGACY_REGION ? [region] : [region, LEGACY_REGION];

  for (const r of targets) {
    const name = jobResourceName(r, clientId, connectorId);
    try {
      await client.pauseJob({ name });
    } catch (err) {
      if (isNotFoundError(err)) continue; // NOT_FOUND in this region — fine.
      // FAILED_PRECONDITION — job is already PAUSED. Idempotent goal:
      // calling pause on an already-paused job is success.
      if (isAlreadyInTargetStateError(err)) continue;
      console.error("[scheduler] pauseJob failed", {
        name,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/**
 * Resume a paused Scheduler job. Schedule + audience + body are
 * preserved from when it was paused — resume just flips state back
 * to ENABLED. The next cron tick fires normally.
 *
 * Idempotent — NOT_FOUND is no-op (treat as already-deleted), and
 * FAILED_PRECONDITION on already-ENABLED jobs is also no-op.
 */
export async function resumeSyncJob(
  clientId: string,
  connectorId: string,
  region: string
): Promise<void> {
  const client = await scheduler();

  // Same dual-region pattern as pauseSyncJob / deleteSyncJob — the
  // job may live in either the new residency region or the legacy
  // europe-west4. Resume both; NOT_FOUND on either is fine.
  const targets =
    region === LEGACY_REGION ? [region] : [region, LEGACY_REGION];

  for (const r of targets) {
    const name = jobResourceName(r, clientId, connectorId);
    try {
      await client.resumeJob({ name });
    } catch (err) {
      if (isNotFoundError(err)) continue; // NOT_FOUND in this region — fine.
      if (isAlreadyInTargetStateError(err)) continue; // already ENABLED
      console.error("[scheduler] resumeJob failed", {
        name,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
