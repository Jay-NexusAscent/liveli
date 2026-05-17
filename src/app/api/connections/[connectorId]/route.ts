import { auth } from "@clerk/nextjs/server";
import { dbReady, connectors } from "@/lib/firestore";
import { getExecutionStatus } from "@/lib/cloud-run";
import { deleteConnectorSecret } from "@/lib/secret-manager";

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
 * Delete the connector: revoke its Secret Manager secret and remove the
 * Firestore record. Idempotent. BigQuery tables that have already been
 * synced are NOT dropped — the user keeps their data even after
 * disconnecting the source. They can drop the workspace dataset
 * separately if they want to fully wipe.
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

    return Response.json({ ok: true, deleted: connectorId });
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
