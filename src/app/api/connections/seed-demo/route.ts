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

  // Detailed error surface — Vercel runtime logs truncate at ~30 chars,
  // so we need the full message + stack returned in the response body
  // to actually diagnose what's failing.
  const step = { current: "init" as string };
  try {
    step.current = "bqReady (WIF auth)";
    const client = await bqReady();

    step.current = "dbReady (WIF auth)";
    await dbReady();

    const datasetId = workspaceDatasetId(orgId);
    const dataset = client.dataset(datasetId);

    step.current = `dataset.exists (${datasetId})`;
    const [exists] = await dataset.exists();

    if (!exists) {
      step.current = `dataset.create (${datasetId}, location=${WORKSPACE_BQ_LOCATION})`;
      await dataset.create({ location: WORKSPACE_BQ_LOCATION });
    }

    for (const table of DEMO_TABLES) {
      step.current = `view ${table}: exists check`;
      const view = dataset.table(table);
      const [viewExists] = await view.exists();
      if (viewExists) {
        step.current = `view ${table}: delete`;
        await view.delete();
      }

      step.current = `view ${table}: create`;
      await view.create({
        view: {
          query: `SELECT * FROM \`${PUBLIC_PROJECT}.${PUBLIC_DATASET}.${table}\``,
          useLegacySql: false,
        },
      });
    }

    step.current = "firestore connector record";
    // Spread DEMO_TABLES so Firestore receives a mutable array (it's
    // declared readonly via `as const` which has bitten us before).
    await connectors(orgId).doc("thelook-demo").set(
      {
        type: "demo",
        name: "TheLook E-commerce (Sample)",
        sourceProject: PUBLIC_PROJECT,
        sourceDataset: PUBLIC_DATASET,
        tables: [...DEMO_TABLES],
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
  } catch (err) {
    // Capture every readable property — google-gax errors have
    // non-standard shapes. Walk own-property names so we don't miss
    // non-enumerable fields.
    const props: Record<string, unknown> = {};
    if (err && typeof err === "object") {
      for (const key of Object.getOwnPropertyNames(err)) {
        try {
          const v = (err as Record<string, unknown>)[key];
          props[key] = typeof v === "function" ? "[function]" : v;
        } catch {
          props[key] = "[unreadable]";
        }
      }
    }
    const body = {
      error: `seed-demo failed at step "${step.current}"`,
      errorType: (err as { constructor?: { name?: string } })?.constructor?.name ?? typeof err,
      errorString: String(err),
      errorProps: props,
    };
    console.error("[seed-demo]", JSON.stringify(body).slice(0, 2000));
    return Response.json(body, { status: 500 });
  }
}
