import { Storage } from "@google-cloud/storage";
import { gcp } from "@/lib/gcp";

/**
 * Helpers for the persistent Meltano state stored in GCS.
 *
 * Layout (mirrored across two regional buckets, one per residency tier):
 *   gs://liveli-meltano-state-eu/<clientId>/<workspaceId>/<connectorId>
 *   gs://liveli-meltano-state-us/<clientId>/<workspaceId>/<connectorId>
 *
 * Meltano writes a single state object per connector (its --state-id maps
 * to the path inside the bucket). Tenant-prefixed paths make per-customer
 * and per-connector cleanup trivial: a single deleteFiles({prefix}) call
 * drops the right scope without enumerating individual objects.
 *
 * Why try both regional buckets on deletion instead of looking up the
 * residency: state files are tiny (~1 KB). A best-effort sweep of both
 * buckets is cheaper than a Firestore round-trip to resolve the
 * workspace's bqLocation, and a 404 on the wrong-region bucket is a
 * cheap no-op (deleteFiles silently ignores empty matches).
 */

let _storage: Storage | null = null;

function storage(): Storage {
  if (_storage) return _storage;
  _storage = new Storage({ projectId: gcp.projectId });
  return _storage;
}

// Both regional state buckets — see infra/storage.tf. Hard-coded list
// because adding a new residency region requires a Terraform change
// anyway (the corresponding bucket has to exist before we can sweep it),
// so coupling here is acceptable.
const STATE_BUCKETS = ["liveli-meltano-state-eu", "liveli-meltano-state-us"];

/**
 * Drop the state object for one connector. Called from the connector-
 * delete route AND from deleteClient's per-connector loop. Idempotent —
 * missing files (e.g. connector never had its first sync) are silent.
 * Errors are logged but never thrown — state cleanup is best-effort
 * and must not block the higher-level deletion flow.
 */
export async function deleteConnectorState(
  clientId: string,
  workspaceId: string,
  connectorId: string
): Promise<void> {
  const prefix = `${clientId}/${workspaceId}/${connectorId}`;
  for (const bucketName of STATE_BUCKETS) {
    try {
      await storage().bucket(bucketName).deleteFiles({ prefix });
    } catch (err) {
      console.warn("[meltano-state] deleteConnectorState bucket sweep failed", {
        bucket: bucketName,
        prefix,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Drop all state objects under a client prefix — called from
 * deleteClient after the per-connector loop has finished, as a sweep
 * for anything orphaned by races / past bugs. Best-effort + idempotent.
 */
export async function deleteClientState(clientId: string): Promise<void> {
  const prefix = `${clientId}/`;
  for (const bucketName of STATE_BUCKETS) {
    try {
      await storage().bucket(bucketName).deleteFiles({ prefix });
    } catch (err) {
      console.warn("[meltano-state] deleteClientState bucket sweep failed", {
        bucket: bucketName,
        prefix,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
