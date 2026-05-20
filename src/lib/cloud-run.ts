import { JobsClient, ExecutionsClient } from "@google-cloud/run";
import { Logging } from "@google-cloud/logging";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _logging: Logging | null = null;

async function loggingClient(): Promise<Logging> {
  await ensureGcpAuth();
  if (_logging) return _logging;
  // @google-cloud/logging's TS types don't include `fallback`, but the
  // underlying gax client accepts it at runtime. Required on Vercel
  // where outbound gRPC is unreliable. Cast through unknown to bypass
  // the strict-property check on the constructor options literal.
  const opts = { projectId: gcp.projectId, fallback: "rest" } as unknown as ConstructorParameters<typeof Logging>[0];
  _logging = new Logging(opts);
  return _logging;
}

let _jobs: JobsClient | null = null;
let _execs: ExecutionsClient | null = null;

async function jobsClient(): Promise<JobsClient> {
  await ensureGcpAuth();
  if (_jobs) return _jobs;
  // fallback:'rest' — same Vercel/serverless gRPC issue as Firestore +
  // Secret Manager. JobsClient defaults to gRPC; serverless can't
  // establish the channel.
  _jobs = new JobsClient({ fallback: "rest" });
  return _jobs;
}

async function execsClient(): Promise<ExecutionsClient> {
  await ensureGcpAuth();
  if (_execs) return _execs;
  _execs = new ExecutionsClient({ fallback: "rest" });
  return _execs;
}

export interface JobEnv {
  [key: string]: string;
}

/**
 * Trigger a Cloud Run Job execution with per-invocation env overrides.
 * Returns the EXECUTION resource name (not the LRO operation name).
 *
 * The `region` parameter MUST come from
 * `cloudComputeRegionForResidency(workspace.bqLocation)` — never a global
 * env var. Connector jobs are deployed in BOTH europe-west1 and
 * us-central1, suffixed `-eu`/`-us`; routing the call to the wrong
 * region returns NOT_FOUND. Pinning to workspace residency keeps EU
 * customer data + compute inside europe-west1 (matches Vertex region).
 *
 * Subtle pitfall: client.runJob() returns a long-running operation
 * (LRO). `operation.name` is the LRO name (".../operations/<id>"),
 * NOT the execution name. The execution is reachable via the LRO's
 * metadata.name which is ".../jobs/<job>/executions/<exec>" — that's
 * what getExecutionStatus() expects.
 *
 * Prior bug: we stored operation.name as lastExecutionName. Subsequent
 * getExecutionStatus() calls 400'd ("invalid resource name"), the
 * reconcile catch fired, and the connector got incorrectly marked
 * "synced" while the underlying job had crashed.
 */
export async function runConnectorJob(
  jobName: string,
  region: string,
  env: JobEnv
): Promise<{ executionName: string }> {
  const client = await jobsClient();
  const parent = `projects/${gcp.projectId}/locations/${region}/jobs/${jobName}`;

  const [operation] = await client.runJob({
    name: parent,
    overrides: {
      containerOverrides: [
        {
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
        },
      ],
    },
  });

  // The LRO's metadata is the partially-populated Execution resource.
  // Its `name` field is the canonical execution resource name we want.
  const metadata = operation.metadata as { name?: string } | undefined;
  const executionName = metadata?.name ?? "";

  if (!executionName) {
    // Defensive — should never happen, but fail loud rather than store
    // an empty string that breaks reconcile downstream.
    throw new Error(
      `runJob returned an LRO with no execution metadata.name. operation.name=${operation.name}`
    );
  }

  return { executionName };
}

/**
 * Poll an execution's current state. Returns one of:
 *  EXECUTION_PENDING | EXECUTION_RUNNING | EXECUTION_SUCCEEDED | EXECUTION_FAILED | EXECUTION_CANCELLED
 */
export async function getExecutionStatus(executionName: string) {
  const client = await execsClient();
  const [execution] = await client.getExecution({ name: executionName });
  return {
    name: execution.name ?? "",
    state: execution.conditions?.[0]?.state ?? "UNKNOWN",
    succeededCount: execution.succeededCount ?? 0,
    failedCount: execution.failedCount ?? 0,
    startTime: execution.startTime,
    completionTime: execution.completionTime,
    logUri: execution.logUri,
  };
}

// ── Live progress (Tier 3) ─────────────────────────────────────────

export type SyncPhase =
  | "starting"
  | "discovery"
  | "extracting"
  | "loading"
  | "finalising"
  | "unknown";

export interface ExecutionProgress {
  recordsProcessed: number;
  phase: SyncPhase;
  latestLogLine: string;
  latestLogAt: Date | null;
}

/**
 * Read recent Cloud Run Job execution logs and parse a coarse "what's
 * happening" snapshot for the in-app progress indicator.
 *
 * We rely on Meltano + tap + target-bigquery's stdout. Patterns we look
 * for (in priority order — later patterns override earlier):
 *
 *   "Discovering"                              → phase: discovery
 *   "Running extract & load"                   → phase: extracting
 *   "extracted N records"                      → phase: extracting + count
 *   "target-bigquery ... loaded N records"     → phase: loading + count
 *   "Loading complete"                         → phase: finalising
 *
 * Best-effort. Failures (perm denied, log API hiccup) return null so the
 * caller can fall back to "still running, elapsed Xs" without the row
 * counts.
 */
export async function getExecutionProgress(
  executionName: string
): Promise<ExecutionProgress | null> {
  // executionName looks like
  //   projects/<p>/locations/<loc>/jobs/<job>/executions/<execId>
  // The Cloud Logging label "run.googleapis.com/execution_name" is just
  // the short execId (last segment).
  const shortId = executionName.split("/").pop();
  if (!shortId) return null;

  try {
    const logging = await loggingClient();
    // Last 5 minutes is plenty — we only care about what's happening now.
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const filter = [
      `resource.type="cloud_run_job"`,
      `labels."run.googleapis.com/execution_name"="${shortId}"`,
      `timestamp >= "${since}"`,
    ].join(" AND ");

    const [entries] = await logging.getEntries({
      filter,
      orderBy: "timestamp desc",
      pageSize: 100,
    });

    let recordsProcessed = 0;
    let phase: SyncPhase = "unknown";
    let latestLogLine = "";
    let latestLogAt: Date | null = null;
    // Patterns Meltano + target-bigquery emit. ANSI-colour codes are
    // stripped from textPayload by Cloud Logging by default.
    const RECORD_RE =
      /(?:emitted|extracted|loaded|processed)\s+(\d[\d,]*)\s+records?/i;

    for (const entry of entries) {
      const md = entry.metadata as {
        textPayload?: string;
        timestamp?: string | Date;
      };
      const text = md.textPayload ?? "";
      if (!text) continue;

      if (!latestLogLine) {
        latestLogLine = text.slice(0, 200);
        if (md.timestamp) {
          latestLogAt =
            md.timestamp instanceof Date
              ? md.timestamp
              : new Date(String(md.timestamp));
        }
      }

      // Phase detection (newest-first iteration, so latest wins via
      // early break once we set a definitive one)
      if (/loading complete|load complete|target.*finished/i.test(text)) {
        phase = "finalising";
      } else if (
        /target-bigquery|loaded \d+ record|Loader is loading/i.test(text)
      ) {
        if (phase === "unknown") phase = "loading";
      } else if (/extract.{0,20}load|extracted \d+ record|tap-\w+/i.test(text)) {
        if (phase === "unknown") phase = "extracting";
      } else if (/discovering|Discovery/i.test(text)) {
        if (phase === "unknown") phase = "discovery";
      } else if (/Environment .* is active|Starting|init/i.test(text)) {
        if (phase === "unknown") phase = "starting";
      }

      // Record-count extraction. Take the MAX across log lines — Meltano
      // emits cumulative counts, so the largest is the latest.
      const recMatch = text.match(RECORD_RE);
      if (recMatch) {
        const n = parseInt(recMatch[1].replace(/,/g, ""), 10);
        if (Number.isFinite(n) && n > recordsProcessed) {
          recordsProcessed = n;
        }
      }
    }

    return { recordsProcessed, phase, latestLogLine, latestLogAt };
  } catch (err) {
    console.error("[cloud-run] getExecutionProgress failed", {
      executionName,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
