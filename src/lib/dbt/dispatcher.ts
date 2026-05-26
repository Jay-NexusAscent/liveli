import { after } from "next/server";
import { runConnectorJob } from "@/lib/cloud-run";
import { cloudComputeRegionForResidency, gcp } from "@/lib/gcp";

/**
 * Connector types that have dbt models in the shared dbt project at
 * `dbt/models/<connector>/`. Used as the dispatch gate: a sync
 * completion for any type NOT in this set is a no-op, even if the
 * dbt-runner Cloud Run Job exists.
 *
 * Adding a new connector to dbt means: (a) drop models under
 * `dbt/models/<type>/` with `tags: ['<type>']`, (b) add the type
 * here. Keep this in sync — the dbt project's tag-based selection
 * AND this gate must agree, or you'll dispatch jobs that do nothing.
 */
const DBT_ENABLED_CONNECTORS = new Set<string>([
  // Tier 1 — highest analytical density
  "stripe",
  "shopify",
  "hubspot",
  "salesforce",
  // Tier 2 — high value, specialised
  "google-ads",
  "facebook-ads",
  "quickbooks",
  "mixpanel",
  "jira",
  // Tier 3 — niche but valuable
  "mailchimp",
  "klaviyo",
  "intercom",
  "zendesk",
  // Originally shipped in dbt v1
  "ga4",
]);

type DbtMode = "off" | "live";

function getMode(): DbtMode {
  // Default to live for v1 — dbt is the v1 ship target, no reason to
  // gate it behind an env var the way metadata enrichment is. If we
  // want to disable in a hurry without a deploy, set DBT_RUNNER_MODE=off
  // in Vercel env.
  const v = process.env.DBT_RUNNER_MODE;
  if (v === "off") return "off";
  return "live";
}

export interface DispatchInput {
  clientId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  bqDataset?: string;
  // Loosely-typed to match the Firestore connector doc (which has
  // historical rows where bqLocation may be any string). Narrowed
  // internally below before being passed to
  // cloudComputeRegionForResidency, which is strict on EU|US.
  bqLocation?: string;
}

/**
 * Trigger the shared dbt-runner Cloud Run Job after a successful
 * connector sync. Fire-and-forget — runs in `next/server` `after()`
 * so the GET /api/connectors response isn't blocked by the dispatch.
 *
 * Tenancy: the dbt-runner ONLY writes to the dataset named in
 * TARGET_BIGQUERY_DATASET. That env var comes from the connector's
 * own Firestore doc (`data.bqDataset` in reconcileStatus), which
 * was provisioned with the customer's tenant context. There's no way
 * for the dispatcher to write to a different customer's dataset.
 *
 * Failure mode: any error is logged and swallowed. The dispatcher
 * must NEVER throw — it runs on the hot path of GET /api/connectors,
 * and a dbt-pipeline bug should never break the connectors list.
 *
 * dbt failure ≠ sync failure. The raw tap output is already in the
 * customer's BQ dataset; missing curated tables just means the agent
 * queries raw instead. Future: surface "dbt last status" on the
 * connector card as a separate signal.
 */
export async function dispatchDbtRun(input: DispatchInput): Promise<void> {
  const mode = getMode();
  if (mode === "off") return;

  // Connector type gate — only fire for types with dbt models.
  if (!DBT_ENABLED_CONNECTORS.has(input.connectorType)) return;

  // Required-field guard — be defensive even though reconcileStatus
  // should always pass these. Missing fields = silent no-op (logged),
  // never a throw.
  if (!input.bqDataset || !input.bqLocation) {
    console.warn("[dbt] dispatch skipped — missing dataset/location", {
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      hasDataset: Boolean(input.bqDataset),
      hasLocation: Boolean(input.bqLocation),
    });
    return;
  }

  // Narrow string → EU|US. Anything unexpected defaults to EU
  // (matches the project's DEFAULT_BQ_LOCATION). Logged so legacy
  // rows with weird location strings surface in ops.
  const location: "EU" | "US" =
    input.bqLocation === "US" ? "US" : "EU";
  if (input.bqLocation !== "EU" && input.bqLocation !== "US") {
    console.warn("[dbt] unexpected bqLocation — defaulting to EU", {
      connectorId: input.connectorId,
      received: input.bqLocation,
    });
  }
  const { region, suffix } = cloudComputeRegionForResidency(location);
  const jobName = `connector-dbt-runner-${suffix}`;

  // Env vars handed to the dbt-runner. Mirrors the connector sync
  // env-var contract (WORKSPACE_ID etc.) so the runner script can
  // share variable names with the connector entrypoints — easier to
  // read both side-by-side. The runner ignores TAP_* vars entirely.
  const env: Record<string, string> = {
    WORKSPACE_ID: input.clientId, // legacy name kept for entrypoint consistency
    CLIENT_ID: input.clientId,
    LIVELI_WORKSPACE_ID: input.workspaceId,
    CONNECTOR_ID: input.connectorId,
    CONNECTOR_TYPE: input.connectorType,
    TARGET_BIGQUERY_PROJECT: gcp.projectId,
    TARGET_BIGQUERY_DATASET: input.bqDataset,
    TARGET_BIGQUERY_LOCATION: location,
  };

  // `after()` defers execution until after the HTTP response is sent
  // — keeps the GET /api/connectors latency unaffected by the dbt
  // dispatch (which takes ~500ms even though the Job itself runs
  // async on Cloud Run).
  after(async () => {
    try {
      const r = await runConnectorJob(jobName, region, env);
      console.log("[dbt] dispatched", {
        connectorId: input.connectorId,
        connectorType: input.connectorType,
        executionName: r.executionName,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[dbt] dispatch failed (swallowed)", {
        clientId: input.clientId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        connectorType: input.connectorType,
        msg,
      });
    }
  });
}
