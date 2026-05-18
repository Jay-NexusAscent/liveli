import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady } from "@/lib/firestore";
import { getExecutionStatus } from "@/lib/cloud-run";
import { deleteConnectorSecret } from "@/lib/secret-manager";
import { bqReady } from "@/lib/bigquery";
import { logUsageEvent } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  _req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const { connectorId } = await context.params;

  await dbReady();
  const snap = await connectorsIn(ctx.clientId, ctx.workspaceId).doc(connectorId).get();
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
 * Delete the connector. In the dataset-per-connector model:
 *   1. Revoke Secret Manager secret (idempotent)
 *   2. Drop the connector's BigQuery dataset (with all its tables)
 *   3. Delete Firestore connector doc
 *
 * Each connector owns ONLY its own dataset, so deletion is always
 * scoped and safe — no need to check for other connectors.
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const { connectorId } = await context.params;
  const step = { current: "init" };

  try {
    step.current = "dbReady";
    await dbReady();

    step.current = "load connector doc";
    const ref = connectorsIn(ctx.clientId, ctx.workspaceId).doc(connectorId);
    const snap = await ref.get();
    if (!snap.exists) {
      return Response.json({ error: "Connector not found" }, { status: 404 });
    }
    const data = snap.data() as { type?: string; bqDataset?: string };

    step.current = "delete Secret Manager secret";
    await deleteConnectorSecret(ctx.clientId, connectorId);

    // Drop the connector's BQ dataset. force:true removes all tables.
    if (data.bqDataset) {
      step.current = `drop BigQuery dataset (${data.bqDataset})`;
      const bq = await bqReady();
      try {
        await bq.dataset(data.bqDataset).delete({ force: true });
      } catch (err) {
        const code = (err as { code?: number })?.code;
        if (code !== 404) throw err;
      }
    }

    step.current = "delete Firestore connector doc";
    await ref.delete();

    logUsageEvent({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      eventType: "connector.delete",
      resource: connectorId,
      labels: { type: data.type ?? "unknown" },
    });

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
