import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("BigQuery"),
  projectId: z.string().min(1).max(128),
  // Customer's own service-account key JSON for THEIR project. This is
  // customer-supplied creds (like a DB password), stored in Secret
  // Manager — it is NOT one of our org-policy-blocked SA keys.
  credentialsJson: z.string().min(2).max(20000),
  datasets: z
    .string()
    .optional()
    .describe("Comma-separated dataset IDs to sync (blank = all datasets)"),
  syncFrequency: z.enum(["5m", "15m", "30m", "1h", "6h", "12h", "24h"]).default("1h"),
});

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
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

  // Validate the pasted credentials are a service-account key JSON
  // BEFORE we provision anything — fail fast with a useful message
  // rather than committing a connector that 401s on first sync.
  let parsedKey: { type?: string; client_email?: string; private_key?: string };
  try {
    parsedKey = JSON.parse(body.credentialsJson);
  } catch {
    return Response.json(
      {
        error:
          "Credentials must be the full service-account key JSON. Paste the file contents you downloaded from Google Cloud.",
      },
      { status: 400 }
    );
  }
  if (
    parsedKey.type !== "service_account" ||
    !parsedKey.client_email ||
    !parsedKey.private_key
  ) {
    return Response.json(
      {
        error:
          "That JSON doesn't look like a service-account key (missing client_email / private_key). Download a key for a service account with BigQuery Data Viewer + Job User on your project.",
      },
      { status: 400 }
    );
  }

  const step = { current: "init" };
  try {
    const datasets = body.datasets?.trim() ?? "";

    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "bigquery",
      name: body.name,
      ctx,
      secretPayload: {
        project_id: body.projectId,
        credentials_json: body.credentialsJson,
        datasets,
      },
      firestoreFields: {
        // Non-sensitive connection metadata for the edit modal. The key
        // JSON itself lives ONLY in Secret Manager.
        projectId: body.projectId,
        serviceAccountEmail: parsedKey.client_email,
        datasets,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Connector saved. Click Sync to start the first import.",
    });
  } catch (err) {
    // Redact the private key out of any stringified error.
    const responseBody = connectErrorEnvelope("bigquery", step.current, err, [
      parsedKey.private_key ?? "",
      body.credentialsJson,
    ]);
    console.error(
      "[bigquery/connect]",
      JSON.stringify(responseBody).slice(0, 2000)
    );
    return Response.json(responseBody, { status: 500 });
  }
}
