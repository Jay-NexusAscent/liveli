import { JobsClient, ExecutionsClient } from "@google-cloud/run";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _jobs: JobsClient | null = null;
let _execs: ExecutionsClient | null = null;

async function jobsClient(): Promise<JobsClient> {
  await ensureGcpAuth();
  if (_jobs) return _jobs;
  _jobs = new JobsClient();
  return _jobs;
}

async function execsClient(): Promise<ExecutionsClient> {
  await ensureGcpAuth();
  if (_execs) return _execs;
  _execs = new ExecutionsClient();
  return _execs;
}

const CLOUD_RUN_REGION = "europe-west4"; // Where the connector jobs live

export interface JobEnv {
  [key: string]: string;
}

/**
 * Trigger a Cloud Run Job execution with per-invocation env overrides.
 * Returns the execution resource name (used to poll status later).
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

  return { executionName: operation.name ?? "" };
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
