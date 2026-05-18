import { auth } from "@clerk/nextjs/server";
import { dbReady, connectors } from "@/lib/firestore";
import { getExecutionStatus } from "@/lib/cloud-run";
import { deleteConnectorSecret } from "@/lib/secret-manager";
import { bqReady, workspaceDatasetId } from "@/lib/bigquery";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  _req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { connectorId } = await context.params;

  await dbReady();
  const snap = await connectors(orgId).doc(connectorId).get();
  if (!snap.exists) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  const data = snap.data() as {
    type: string;
    status: string;
    lastExecutionName?: string;
    bqDataset?: string;
    [k: string]: unknown;
  };

  let execution = null;
  if (data.lastExecutionName) {
    try {
      execution = await getExecutionStatus(data.lastExecutionName);
    } catch {
      // Execution may have been garbage-collected; ignore
    }
  }

  return Response.json({
    id: snap.id,
    ...data,
    execution,
  });
}

/**
 * Delete the connector. Order of operations:
 *   1. Revoke Secret Manager secret (idempotent — NOT_FOUND treated OK)
 *   2. Delete Firestore connector doc
 *   3. If this was the LAST connector for the workspace, drop the
 *      BigQuery dataset (with force:true to remove all tables in it).
 *
 * Step 3 is the safe form of "give me back my disk space" — if other
 * connectors are still using the same workspace dataset, we don't
 * touch it. Once we migrate to dataset-per-connector (architecture B
 * in the design doc), step 3 becomes simpler: each connector owns
 * its dataset, so deleting the connector always drops its dataset.
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { connectorId } = await context.params;
  const step = { current: "init" };

  try {
    step.current = "dbReady";
    await dbReady();

    step.current = "load connector doc";
    const ref = connectors(orgId).doc(connectorId);
    const snap = await ref.get();
    if (!snap.exists) {
      return Response.json({ error: "Connector not found" }, { status: 404 });
    }
    const data = snap.data() as { type?: string };

    // Demo connector has no Secret Manager secret to revoke.
    if (data.type !== "demo") {
      step.current = "delete Secret Manager secret";
      await deleteConnectorSecret(orgId, connectorId);
    }

    step.current = "delete Firestore connector doc";
    await ref.delete();

    // If this was the last connector for the workspace, drop the
    // shared BigQuery dataset. We check AFTER the delete so we don't
    // race with another concurrent connect.
    step.current = "check remaining connectors";
    const remaining = await connectors(orgId).limit(1).get();
    let datasetDropped = false;
    if (remaining.empty) {
      step.current = "drop workspace BigQuery dataset";
      const bq = await bqReady();
      const datasetId = workspaceDatasetId(orgId);
      try {
        // force:true drops the dataset even if it contains tables.
        await bq.dataset(datasetId).delete({ force: true });
        datasetDropped = true;
      } catch (err) {
        // 404 = dataset already gone. Anything else, surface.
        const code = (err as { code?: number })?.code;
        if (code !== 404) throw err;
      }
    }

    return Response.json({
      ok: true,
      deleted: connectorId,
      datasetDropped,
    });
  } catch (err) {
    const props: Record<string, unknown> = {};
    if (err && typeof err === "object") {
      for (const key of Object.getOwnPropertyNames(err)) {
        try {
          props[key] = (err as Record<string, unknown>)[key];
        } catch {
          props[key] = "[unreadable]";
        }
      }
    }
    return Response.json(
      {
        error: `delete failed at step "${step.current}"`,
        errorMessage: (err as { message?: string })?.message ?? String(err),
        errorProps: props,
      },
      { status: 500 }
    );
  }
}
