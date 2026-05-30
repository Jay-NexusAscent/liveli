/**
 * Cloud Run Job entrypoint for the metadata enrichment agent.
 *
 * This is the standalone (non-Next.js) entrypoint. The dispatcher in
 * src/lib/metadata/dispatcher.ts launches the `metadata-agent-<eu|us>`
 * Cloud Run Job with per-invocation env overrides; this script reads
 * that context and runs one enrichment pass.
 *
 * Auth: runs as the natively-attached `liveli-agent-metadata` SA.
 * ensureGcpAuth() (called transitively by the SDK wrappers) no-ops off
 * Vercel, so the @google-cloud/* SDKs discover the attached SA via ADC
 * from the Cloud Run metadata server. No impersonation, no key files.
 *
 * Exit codes:
 *   0 — agent finished (status "finished" or "max-turns")
 *   1 — agent run errored, or a fatal uncaught error
 *   2 — missing required env (misconfiguration)
 */
import { runMetadataAgent } from "@/lib/metadata/agent";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[metadata-agent-job] missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const ctx = {
    clientId: requireEnv("CLIENT_ID"),
    workspaceId: requireEnv("WORKSPACE_ID"),
    connectorId: requireEnv("CONNECTOR_ID"),
    connectorType: requireEnv("CONNECTOR_TYPE"),
    bqDataset: requireEnv("BQ_DATASET"),
    bqLocation: requireEnv("BQ_LOCATION"),
  };

  console.log("[metadata-agent-job] starting", {
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    connectorId: ctx.connectorId,
    connectorType: ctx.connectorType,
    bqDataset: ctx.bqDataset,
    bqLocation: ctx.bqLocation,
  });

  const result = await runMetadataAgent(ctx);

  console.log("[metadata-agent-job] complete", result);

  // status "error" → non-zero so Cloud Run marks the execution failed
  // and the failure is visible in the execution list + logs. "max-turns"
  // is a clean partial-completion (next sync picks up the rest), so it
  // exits 0.
  process.exit(result.status === "error" ? 1 : 0);
}

main().catch((err) => {
  console.error(
    "[metadata-agent-job] fatal",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
