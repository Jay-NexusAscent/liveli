import { FieldValue } from "@google-cloud/firestore";
import { bqReady } from "@/lib/bigquery";
import { dbReady, connectorsIn } from "@/lib/firestore";
import { assertDatasetMatchesConnector } from "./dataset-isolation";

/**
 * Where a description came from. Used to decide whether the metadata
 * agent is allowed to overwrite it on the next run — agent-written
 * descriptions are fair game to re-enrich, but human-edited or
 * first-party-manifest ones must not be clobbered.
 */
export type MetadataSource = "agent" | "first-party-manifest" | "user-edit";

export interface WriteConnectorContext {
  clientId: string;
  workspaceId: string;
  connectorId: string;
  bqDataset: string;
}

/**
 * Firestore subcollection path for the per-table metadata mirror.
 *
 * Nesting under the connector doc means the existing connector
 * security rules already cover reads/writes — no separate rule
 * surface — and a connector delete cascades cleanly.
 */
function tableMetadataDocRef(ctx: WriteConnectorContext, tableId: string) {
  return connectorsIn(ctx.clientId, ctx.workspaceId)
    .doc(ctx.connectorId)
    .collection("tableMetadata")
    .doc(tableId);
}

interface WriteTableDescriptionInput {
  ctx: WriteConnectorContext;
  tableId: string;
  description: string;
  source: MetadataSource;
  /** When true, overwrite existing non-agent descriptions. Default false. */
  force?: boolean;
  /** Optional semantic role (e.g. "fact_transactions", "dim_customers"). */
  semanticRole?: string;
}

export type WriteSkipReason =
  | "already-described-by-human"
  | "already-described-by-manifest"
  | "struct-leaf-not-supported"
  | "column-not-found";

export interface WriteResult {
  written: boolean;
  reason?: WriteSkipReason;
}

/**
 * Write a table-level description to BigQuery, and mirror it to the
 * Firestore registry. Idempotent in the sense that re-running for a
 * table already described by the agent will overwrite (the agent's
 * judgement can improve); a description sourced from a human or a
 * first-party manifest is protected unless `force: true`.
 *
 * Tenancy: rejects if `bqDataset` doesn't match the (clientId,
 * workspaceId, connectorId) tuple. This is the same defence-in-depth
 * check used by the pre-flight gate.
 */
export async function writeTableDescription(
  input: WriteTableDescriptionInput,
): Promise<WriteResult> {
  assertDatasetMatchesConnector(
    input.ctx.bqDataset,
    input.ctx.clientId,
    input.ctx.workspaceId,
    input.ctx.connectorId,
  );

  await dbReady();
  const mirrorRef = tableMetadataDocRef(input.ctx, input.tableId);
  const mirrorSnap = await mirrorRef.get();
  const mirror = mirrorSnap.data() as
    | { source?: MetadataSource; description?: string }
    | undefined;

  if (!input.force && mirror?.source && mirror.source !== "agent") {
    return {
      written: false,
      reason:
        mirror.source === "user-edit"
          ? "already-described-by-human"
          : "already-described-by-manifest",
    };
  }

  const client = await bqReady();
  const table = client.dataset(input.ctx.bqDataset).table(input.tableId);
  await table.setMetadata({ description: input.description });

  await mirrorRef.set(
    {
      datasetId: input.ctx.bqDataset,
      tableId: input.tableId,
      description: input.description,
      source: input.source,
      ...(input.semanticRole ? { semanticRole: input.semanticRole } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { written: true };
}

interface WriteColumnDescriptionInput {
  ctx: WriteConnectorContext;
  tableId: string;
  /**
   * Top-level column name. STRUCT leaf paths (e.g. `address.postcode`)
   * are not yet supported by this writer and will be rejected. The
   * pre-flight gate filters them out of the worklist for now.
   */
  columnName: string;
  description: string;
  source: MetadataSource;
  force?: boolean;
  /** Optional semantic type (e.g. "currency", "identifier", "event_timestamp"). */
  semanticType?: string;
}

interface BqField {
  name: string;
  type?: string;
  mode?: string;
  description?: string;
  fields?: BqField[];
}

/**
 * Write a column-level description on a BigQuery table. BigQuery's API
 * doesn't expose per-column patching — we have to read the whole
 * schema, mutate the matching field's description, and write the
 * schema back. We do this read-modify-write atomically against a
 * single `getMetadata` snapshot.
 *
 * Limitation: this slice only handles top-level (scalar) columns.
 * STRUCT leaf paths return `{ written: false, reason: ... }` rather
 * than throwing, so the agent can keep working. STRUCT support is a
 * follow-up.
 */
export async function writeColumnDescription(
  input: WriteColumnDescriptionInput,
): Promise<WriteResult> {
  assertDatasetMatchesConnector(
    input.ctx.bqDataset,
    input.ctx.clientId,
    input.ctx.workspaceId,
    input.ctx.connectorId,
  );

  if (input.columnName.includes(".")) {
    return { written: false, reason: "struct-leaf-not-supported" };
  }

  await dbReady();
  const mirrorRef = tableMetadataDocRef(input.ctx, input.tableId);
  const mirrorSnap = await mirrorRef.get();
  const mirror = mirrorSnap.data() as
    | {
        columns?: Record<
          string,
          { description?: string; source?: MetadataSource }
        >;
      }
    | undefined;
  const existingMirror = mirror?.columns?.[input.columnName];

  if (
    !input.force &&
    existingMirror?.source &&
    existingMirror.source !== "agent"
  ) {
    return {
      written: false,
      reason:
        existingMirror.source === "user-edit"
          ? "already-described-by-human"
          : "already-described-by-manifest",
    };
  }

  const client = await bqReady();
  const table = client.dataset(input.ctx.bqDataset).table(input.tableId);
  const [meta] = await table.getMetadata();
  const fields = (meta.schema?.fields ?? []) as BqField[];
  const target = fields.find((f) => f.name === input.columnName);
  if (!target) {
    return { written: false, reason: "column-not-found" };
  }

  // Mutate in place. BigQuery's setMetadata accepts the full schema and
  // diffs against the current state — fields not present get removed,
  // so we MUST pass back every existing field unchanged.
  target.description = input.description;

  await table.setMetadata({
    schema: { fields },
  });

  await mirrorRef.set(
    {
      datasetId: input.ctx.bqDataset,
      tableId: input.tableId,
      columns: {
        [input.columnName]: {
          description: input.description,
          source: input.source,
          ...(input.semanticType ? { semanticType: input.semanticType } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { written: true };
}
