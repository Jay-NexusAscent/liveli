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

const REGION = "europe-west4"; // Same region as our Cloud Run Jobs

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

function jobResourceName(clientId: string, connectorId: string): string {
  return `projects/${gcp.projectId}/locations/${REGION}/jobs/${syncJobName(clientId, connectorId)}`;
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
  const parent = `projects/${gcp.projectId}/locations/${REGION}`;
  const name = jobResourceName(args.clientId, args.connectorId);
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
    // 6 = ALREADY_EXISTS — switch to updateJob with full mask
    const code = (err as { code?: number })?.code;
    if (code === 6) {
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
  connectorId: string
): Promise<void> {
  const client = await scheduler();
  const name = jobResourceName(clientId, connectorId);
  try {
    await client.deleteJob({ name });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 5) return; // NOT_FOUND
    console.error("[scheduler] deleteJob failed", {
      name,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
