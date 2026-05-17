import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { gcp } from "@/lib/gcp";

let _sm: SecretManagerServiceClient | null = null;

function sm(): SecretManagerServiceClient {
  if (_sm) return _sm;
  // fallback:'rest' — same Vercel/serverless gRPC issue as Firestore.
  // SecretManagerServiceClient defaults to gRPC over HTTP/2; Vercel can't
  // establish the channel, every call fails with the empty-field gax error.
  // Forcing HTTPS/JSON fallback transport.
  _sm = new SecretManagerServiceClient({ fallback: "rest" });
  return _sm;
}

/**
 * Per-connector secret name. Connector credentials are scoped to their
 * connector ID and workspace, so a connector belonging to workspace A can
 * never be read by code running for workspace B.
 */
export function connectorSecretName(orgId: string, connectorId: string): string {
  return `liveli-cn-${slugify(orgId)}-${slugify(connectorId)}`;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

/**
 * Create a secret (if it doesn't exist) and add a new version. Returns the
 * resource name suitable for use in env-var references.
 */
export async function storeConnectorSecret(
  orgId: string,
  connectorId: string,
  payload: Record<string, string>
): Promise<string> {
  const name = connectorSecretName(orgId, connectorId);
  const parent = `projects/${gcp.projectId}`;
  const client = sm();

  // Idempotent create.
  try {
    await client.createSecret({
      parent,
      secretId: name,
      secret: {
        replication: { automatic: {} },
        labels: { workspace: slugify(orgId), connector: slugify(connectorId) },
      },
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 6) throw err; // 6 = ALREADY_EXISTS
  }

  const [version] = await client.addSecretVersion({
    parent: `${parent}/secrets/${name}`,
    payload: { data: Buffer.from(JSON.stringify(payload), "utf8") },
  });
  return version.name ?? "";
}

export async function readConnectorSecret(
  orgId: string,
  connectorId: string
): Promise<Record<string, string>> {
  const name = connectorSecretName(orgId, connectorId);
  const [version] = await sm().accessSecretVersion({
    name: `projects/${gcp.projectId}/secrets/${name}/versions/latest`,
  });
  const data = version.payload?.data?.toString();
  if (!data) throw new Error(`Empty secret ${name}`);
  return JSON.parse(data);
}
