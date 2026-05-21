import { connectorDatasetId } from "@/lib/bigquery";

/**
 * Thrown when a connector's stored bqDataset name doesn't match the
 * canonical name derived from (clientId, workspaceId, connectorId).
 *
 * This should never happen in normal operation — it indicates either a
 * data-corruption bug (someone wrote the wrong dataset name to the
 * Firestore doc) or an attempted tenancy violation (the dispatcher
 * being asked to operate on a dataset that doesn't belong to this
 * connector). Either way, the metadata pipeline must refuse to proceed.
 */
export class DatasetIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetIsolationError";
  }
}

/**
 * Defence-in-depth check that the dataset we're about to touch is the
 * one that legitimately belongs to (clientId, workspaceId, connectorId).
 *
 * The dataset name is reconstructed from the three IDs via the canonical
 * generator and compared string-equal to the supplied bqDataset. If
 * they disagree we throw rather than continuing — the metadata pipeline
 * has no business operating on a dataset whose identity it can't verify.
 *
 * Call this at every boundary where a dataset name crosses code:
 *   - dispatcher entry (before any BQ read)
 *   - Cloud Run Job entry (after re-fetching connector from Firestore)
 *   - every tool that takes a dataset/table argument
 */
export function assertDatasetMatchesConnector(
  bqDataset: string,
  clientId: string,
  workspaceId: string,
  connectorId: string,
): void {
  const expected = connectorDatasetId(clientId, workspaceId, connectorId);
  if (bqDataset !== expected) {
    throw new DatasetIsolationError(
      `Dataset mismatch: expected "${expected}" derived from (clientId="${clientId}", workspaceId="${workspaceId}", connectorId="${connectorId}"), got "${bqDataset}"`,
    );
  }
}
