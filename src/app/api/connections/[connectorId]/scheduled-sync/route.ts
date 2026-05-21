import { FieldValue } from "@google-cloud/firestore";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import {
  connectorsIn,
  dbReady,
  workspaceDoc,
} from "@/lib/firestore";
import { readConnectorSecret } from "@/lib/secret-manager";
import { runConnectorJob } from "@/lib/cloud-run";
import { cloudComputeRegionForResidency, gcp } from "@/lib/gcp";
import {
  cleanupStaleStagingTables,
  DEFAULT_BQ_LOCATION,
} from "@/lib/bigquery";
import {
  buildTapEnv,
  UnsupportedConnectorTypeError,
} from "@/lib/connector-env";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Cloud-Scheduler-only sync trigger.
 *
 * Differs from /api/connections/[id]/sync (the user-facing "Sync now"
 * route) in that:
 *   - There's no Clerk session — Cloud Scheduler is the caller.
 *   - Auth is via OIDC token signed by our scheduler SA, verified here.
 *   - clientId + workspaceId come from the request body (Scheduler put
 *     them there at job-create time), not from the Clerk session.
 *
 * The actual sync orchestration is identical: load connector doc, fetch
 * credentials from Secret Manager, kick off the Cloud Run Job.
 */

const Body = z.object({
  clientId: z.string().min(1),
  workspaceId: z.string().min(1),
});

const oauth = new OAuth2Client();

export async function POST(
  req: Request,
  ctx: { params: Promise<{ connectorId: string }> }
) {
  // ── 1. Verify OIDC token from Cloud Scheduler ──────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length).trim();

  const allowedSa =
    process.env.LIVELI_SCHEDULER_SA_EMAIL ||
    `liveli-runtime@${gcp.projectId}.iam.gserviceaccount.com`;

  // SECURITY: do NOT derive the audience from req.url. The Host header
  // is attacker-controllable (Vercel proxies whatever's in there to our
  // function). An attacker who can reach this endpoint with a Host header
  // matching the audience claim of a stolen/replayed Cloud Scheduler OIDC
  // token would bypass verification entirely.
  //
  // Instead, build the audience from a server-controlled origin
  // (LIVELI_SCHEDULER_AUDIENCE_ORIGIN env var, falls back to the configured
  // app URL, falls back to a known-good production hostname). The path
  // portion is trustworthy — it's what Next.js routed on, not the Host.
  const url = new URL(req.url);
  const audienceOrigin = (
    process.env.LIVELI_SCHEDULER_AUDIENCE_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://app.liveli.co.uk"
  ).replace(/\/$/, "");
  const expectedAudience = `${audienceOrigin}${url.pathname}`;

  try {
    const ticket = await oauth.verifyIdToken({
      idToken: token,
      audience: expectedAudience,
    });
    const payload = ticket.getPayload();
    if (!payload || payload.email !== allowedSa) {
      console.error("[scheduled-sync] OIDC sender not allowed", {
        emailReceived: payload?.email,
        allowedSa,
      });
      return Response.json({ error: "Unauthorized sender" }, { status: 401 });
    }
  } catch (err) {
    console.error("[scheduled-sync] OIDC verify failed", {
      err: err instanceof Error ? err.message : String(err),
      audience: expectedAudience,
    });
    return Response.json({ error: "Invalid OIDC token" }, { status: 401 });
  }

  // ── 2. Parse body ──────────────────────────────────────────────
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  const { connectorId } = await ctx.params;
  const { clientId, workspaceId } = body;

  // ── 3. Load connector doc + check deletion state ───────────────
  await dbReady();
  const ref = connectorsIn(clientId, workspaceId).doc(connectorId);
  const snap = await ref.get();
  if (!snap.exists) {
    // Connector was deleted between Scheduler's last run and now —
    // tell Scheduler to stop retrying. The createSyncJob lifecycle
    // should also have torn down the job, but races can happen.
    console.warn("[scheduled-sync] connector not found, dropping job", {
      clientId,
      workspaceId,
      connectorId,
    });
    return Response.json({ skipped: "connector deleted" }, { status: 200 });
  }
  const data = snap.data() as {
    type: string;
    bqDataset: string;
    bqLocation?: "EU" | "US";
    deletionState?: string;
  };

  if (data.deletionState === "scheduled") {
    // Soft-delete is in progress — pause syncs.
    console.warn("[scheduled-sync] connector deletion pending, skipping sync", {
      connectorId,
    });
    return Response.json({ skipped: "deletion scheduled" }, { status: 200 });
  }

  // ── 4. Resolve BQ location + creds ─────────────────────────────
  let location: string = data.bqLocation ?? DEFAULT_BQ_LOCATION;
  if (!data.bqLocation) {
    const wsSnap = await workspaceDoc(clientId, workspaceId).get();
    location = (wsSnap.data() as { bqLocation?: string })?.bqLocation ?? location;
  }

  // Compute region follows residency: EU → europe-west1, US → us-central1.
  const { region, suffix } = cloudComputeRegionForResidency(
    location === "US" || location === "EU" ? location : "EU"
  );

  const creds = await readConnectorSecret(clientId, connectorId);

  // ── 5. Build env + trigger Cloud Run Job ───────────────────────
  const jobName = `connector-${data.type}-to-bq-${suffix}`;
  const env: Record<string, string> = {
    WORKSPACE_ID: clientId, // legacy var name
    CLIENT_ID: clientId,
    LIVELI_WORKSPACE_ID: workspaceId,
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

  // Drop any orphan staging tables from previous failed merges. Same
  // pattern as /sync — fire-and-forget pre-run sweep. See
  // cleanupStaleStagingTables docstring for full rationale.
  await cleanupStaleStagingTables(data.bqDataset);

  let executionName: string;
  try {
    const r = await runConnectorJob(jobName, region, env);
    executionName = r.executionName;
  } catch (err) {
    const technical = err instanceof Error ? err.message : String(err);
    console.error("[scheduled-sync] runConnectorJob failed", {
      connectorId,
      clientId,
      msg: technical,
    });
    await ref.update({
      status: "error",
      lastError:
        "Scheduled sync failed to start. We're looking into it — contact support if this persists.",
      lastErrorDiagnosticMessage: technical,
      lastSyncAttemptAt: FieldValue.serverTimestamp(),
    });
    return Response.json({ error: "Failed to start sync" }, { status: 500 });
  }

  await ref.update({
    status: "syncing",
    lastExecutionName: executionName,
    lastSyncAttemptAt: FieldValue.serverTimestamp(),
    lastError: FieldValue.delete(),
  });

  return Response.json({ ok: true, executionName, source: "scheduled" });
}
