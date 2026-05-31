import { runConnectorJob } from "@/lib/cloud-run";
import { cloudComputeRegionForResidency } from "@/lib/gcp";
import { findUncoveredMetadata } from "./pre-flight";

/**
 * Connector types whose schemas are well-known and can be enriched
 * via static manifests rather than via the LLM agent. Populated as
 * manifests are authored under `src/lib/metadata/known-schemas/`.
 */
const KNOWN_SCHEMA_CONNECTORS = new Set<string>([]);

/**
 * Initial test gate: only fire the dispatcher for these connector
 * types while we validate behaviour against the Postgres demo
 * connector. Lift this restriction (delete the set or replace with
 * an explicit exclude-list) once dry-run logs confirm the gate is
 * trustworthy across other custom-DB connectors.
 */
const INITIAL_TEST_TYPES = new Set<string>([
  "postgres",
  "sqlserver",
  "redshift",
  "synapse",
  "bigquery",
  // Batch E (LIVELI-134): warehouse-style DB connectors with rich
  // column schemas worth enriching. MongoDB is intentionally excluded —
  // its documents land as a single JSON column, so there's no per-column
  // schema for the agent to describe.
  "snowflake",
  "oracle",
]);

type EnrichmentMode = "off" | "dry-run" | "live";

function getMode(): EnrichmentMode {
  const v = process.env.METADATA_ENRICHMENT_MODE;
  if (v === "dry-run" || v === "live") return v;
  return "off";
}

export interface DispatchInput {
  clientId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  bqDataset?: string;
  bqLocation?: string;
}

/**
 * Decide whether enrichment work is needed, and if so, schedule it.
 *
 *   - METADATA_ENRICHMENT_MODE=off (default): no-op.
 *   - METADATA_ENRICHMENT_MODE=dry-run: runs the pre-flight gate and
 *     logs what would happen. No writes.
 *   - METADATA_ENRICHMENT_MODE=live: runs the pre-flight gate and,
 *     if anything is uncovered, launches the metadata-agent Cloud Run
 *     Job (region-matched to the workspace residency). runJob returns
 *     as soon as the execution is created — the agent runs in its own
 *     process under the least-privileged liveli-agent-metadata SA, so
 *     the /api/connectors response isn't blocked on the agent.
 *
 * Tenancy: every downstream component (pre-flight, writers, tools)
 * verifies dataset isolation. The dispatcher just routes to them.
 *
 * Failure mode: any error inside the dispatcher is logged and swallowed.
 * The dispatcher must NEVER throw — it runs on the hot path of
 * GET /api/connectors, and a metadata-pipeline bug should never break
 * the connectors list.
 */
export async function dispatchMetadataEnrichment(
  input: DispatchInput,
): Promise<void> {
  const mode = getMode();
  if (mode === "off") return;

  if (!INITIAL_TEST_TYPES.has(input.connectorType)) return;

  if (!input.bqDataset || !input.bqLocation) {
    console.warn("[metadata] dispatch skipped — missing dataset/location", {
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      hasDataset: Boolean(input.bqDataset),
      hasLocation: Boolean(input.bqLocation),
    });
    return;
  }

  try {
    const startedAt = Date.now();
    const uncovered = await findUncoveredMetadata({
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      bqDataset: input.bqDataset,
      bqLocation: input.bqLocation,
    });
    const totalUncovered =
      uncovered.tables.length +
      uncovered.columns.length +
      (uncovered.datasetDescriptionMissing ? 1 : 0);

    console.log("[metadata] pre-flight gate", {
      mode,
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      connectorType: input.connectorType,
      bqDataset: input.bqDataset,
      durationMs: Date.now() - startedAt,
      uncoveredTables: uncovered.tables.length,
      uncoveredColumns: uncovered.columns.length,
      datasetDescriptionMissing: uncovered.datasetDescriptionMissing,
      totalUncovered,
      sampleUncoveredTables: uncovered.tables.slice(0, 10),
      sampleUncoveredColumns: uncovered.columns.slice(0, 20),
    });

    if (totalUncovered === 0) {
      console.log("[metadata] gate result: skip — all fields populated", {
        connectorId: input.connectorId,
      });
      return;
    }

    const isKnownSchema = KNOWN_SCHEMA_CONNECTORS.has(input.connectorType);
    console.log("[metadata] gate result: trigger enrichment", {
      connectorId: input.connectorId,
      path: isKnownSchema ? "known-schema-manifest" : "agent",
      targetTables: uncovered.tables.length,
      targetColumns: uncovered.columns.length,
      needsDatasetDescription: uncovered.datasetDescriptionMissing,
    });

    if (mode === "dry-run") return;

    if (isKnownSchema) {
      // Known-schema path lands in a follow-up. Don't accidentally
      // run the LLM agent on a connector type that should have used
      // the deterministic manifest.
      console.warn(
        "[metadata] known-schema enrichment not yet implemented — skipping live dispatch",
        { connectorType: input.connectorType },
      );
      return;
    }

    // Live mode. Launch the metadata-agent Cloud Run Job, region-matched
    // to the workspace residency (same EU/US suffix scheme as connector
    // jobs). The agent runs in its own process under the least-privileged
    // liveli-agent-metadata SA, with a 900s job timeout (vs the 300s
    // Vercel function ceiling the old after() path was capped at).
    // runJob returns as soon as the execution is created, so we don't
    // block the connectors-list response on the (minutes-long) run.
    const residency =
      input.bqLocation === "US" || input.bqLocation === "EU"
        ? input.bqLocation
        : undefined;
    const { region, suffix } = cloudComputeRegionForResidency(residency);
    const jobName = `metadata-agent-${suffix}`;
    const { executionName } = await runConnectorJob(jobName, region, {
      CLIENT_ID: input.clientId,
      WORKSPACE_ID: input.workspaceId,
      CONNECTOR_ID: input.connectorId,
      CONNECTOR_TYPE: input.connectorType,
      BQ_DATASET: input.bqDataset,
      BQ_LOCATION: input.bqLocation,
    });
    console.log("[metadata] launched enrichment job", {
      connectorId: input.connectorId,
      jobName,
      region,
      executionName,
      targetTables: uncovered.tables.length,
      targetColumns: uncovered.columns.length,
      needsDatasetDescription: uncovered.datasetDescriptionMissing,
    });
  } catch (err) {
    console.error("[metadata] dispatcher failed", {
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
