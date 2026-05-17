import { auth } from "@clerk/nextjs/server";
import { FieldValue } from "@google-cloud/firestore";
import { bqReady, workspaceDatasetId, WORKSPACE_BQ_LOCATION } from "@/lib/bigquery";
import { dbReady, connectors } from "@/lib/firestore";
import { gcp } from "@/lib/gcp";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Seed the workspace with the public TheLook E-commerce dataset as
 * federated views — zero data movement, instant setup. Idempotent.
 *
 * Views point at `bigquery-public-data.thelook_ecommerce.*`. The
 * workspace dataset must be in `US` to view US-hosted tables.
 */

const DEMO_TABLES = [
  "users",
  "products",
  "orders",
  "order_items",
  "distribution_centers",
] as const;

const PUBLIC_PROJECT = "bigquery-public-data";
const PUBLIC_DATASET = "thelook_ecommerce";

export async function POST() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = await bqReady();
  await dbReady();
  const datasetId = workspaceDatasetId(orgId);
  const dataset = client.dataset(datasetId);

  // Create workspace dataset (US to match public dataset location)
  const [exists] = await dataset.exists();
  if (!exists) {
    await dataset.create({ location: WORKSPACE_BQ_LOCATION });
  }

  // Drop and recreate each view so re-running the seed picks up any
  // upstream schema changes.
  for (const table of DEMO_TABLES) {
    const view = dataset.table(table);
    const [viewExists] = await view.exists();
    if (viewExists) await view.delete();

    await view.create({
      view: {
        query: `SELECT * FROM \`${PUBLIC_PROJECT}.${PUBLIC_DATASET}.${table}\``,
        useLegacySql: false,
      },
    });
  }

  // Record / upsert the connector in Firestore
  await connectors(orgId).doc("thelook-demo").set(
    {
      type: "demo",
      name: "TheLook E-commerce (Sample)",
      sourceProject: PUBLIC_PROJECT,
      sourceDataset: PUBLIC_DATASET,
      tables: DEMO_TABLES,
      status: "synced",
      syncedAt: FieldValue.serverTimestamp(),
      seededBy: userId,
    },
    { merge: true }
  );

  return Response.json({
    ok: true,
    workspaceDataset: `${gcp.projectId}.${datasetId}`,
    tables: DEMO_TABLES,
  });
}
