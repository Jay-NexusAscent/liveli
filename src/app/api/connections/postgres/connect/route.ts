import { auth } from "@clerk/nextjs/server";
import { FieldValue } from "@google-cloud/firestore";
import { z } from "zod";
import { dbReady, connectors } from "@/lib/firestore";
import { storeConnectorSecret } from "@/lib/secret-manager";
import { workspaceDatasetId, bqReady, WORKSPACE_BQ_LOCATION } from "@/lib/bigquery";
import { gcp } from "@/lib/gcp";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Postgres"),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  ssl: z.boolean().default(true),
  schemas: z.string().optional().describe("Comma-separated schemas to sync (default: public)"),
});

export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  await dbReady();

  // 1. Create the connector doc in Firestore (so we have an ID for the secret name)
  const connectorRef = connectors(orgId).doc();
  const connectorId = connectorRef.id;

  // 2. Ensure workspace BQ dataset exists (US for compatibility with public data)
  const client = await bqReady();
  const datasetId = workspaceDatasetId(orgId);
  const [exists] = await client.dataset(datasetId).exists();
  if (!exists) {
    await client.dataset(datasetId).create({ location: WORKSPACE_BQ_LOCATION });
  }

  // 3. Store the connector credentials in Secret Manager
  const secretRef = await storeConnectorSecret(orgId, connectorId, {
    host: body.host,
    port: String(body.port),
    database: body.database,
    user: body.user,
    password: body.password,
    ssl: body.ssl ? "true" : "false",
    schemas: body.schemas ?? "public",
  });

  // 4. Record the connector in Firestore
  await connectorRef.set({
    type: "postgres",
    name: body.name,
    status: "configured", // -> "syncing" once sync starts -> "synced" on success
    host: body.host,
    port: body.port,
    database: body.database,
    user: body.user,
    ssl: body.ssl,
    schemas: body.schemas ?? "public",
    secretRef,
    createdBy: userId,
    createdAt: FieldValue.serverTimestamp(),
    bqProject: gcp.projectId,
    bqDataset: datasetId,
  });

  return Response.json({
    ok: true,
    connectorId,
    message: "Connector saved. Click Sync to start the first import.",
  });
}
