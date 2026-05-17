import { auth } from "@clerk/nextjs/server";
import { dbReady, connectors } from "@/lib/firestore";
import { getExecutionStatus } from "@/lib/cloud-run";

export const runtime = "nodejs";

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
