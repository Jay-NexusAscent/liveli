import { JobsClient, ExecutionsClient } from "@google-cloud/run";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

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

const CLOUD_RUN_REGION = "europe-west4"; // Where the connector jobs live

export interface JobEnv {
  [key: string]: string;
}

/**
 * Trigger a Cloud Run Job execution with per-invocation env overrides.
 * Returns the EXECUTION resource name (not the LRO operation name).
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
  env: JobEnv
): Promise<{ executionName: string }> {
  const client = await jobsClient();
  const parent = `projects/${gcp.projectId}/locations/${CLOUD_RUN_REGION}/jobs/${jobName}`;

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
