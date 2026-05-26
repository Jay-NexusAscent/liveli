import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

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
 * Initialise WIF credentials before any Secret Manager SDK call.
 *
 * Same pattern as firestore.ts (dbReady) and bigquery.ts (bqReady):
 * every Google Cloud client needs ADC — and on Vercel that means
 * exchanging Vercel's OIDC token for GCP credentials via
 * ensureGcpAuth(). Without this, the very first SDK call in a request
 * lifecycle fails with "Could not load the default credentials".
 *
 * Existing callers of this module (sync route, connect routes) were
 * accidentally protected by call order — they always hit Firestore
 * first (which calls ensureGcpAuth via dbReady) before Secret Manager.
 * The OAuth callback route inverts that order — it reads the HMAC key
 * from Secret Manager BEFORE touching Firestore — which exposed the
 * latent bug as a 500 on every OAuth callback. See LIVELI-132.
 *
 * `ensureGcpAuth` is idempotent + cheap after first call (just checks
 * /tmp/gcp-wif-creds.json exists), so the per-call cost is negligible.
 */
async function smReady(): Promise<SecretManagerServiceClient> {
  await ensureGcpAuth();
  return sm();
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
  const client = await smReady();

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
  const client = await smReady();
  const [version] = await client.accessSecretVersion({
    name: `projects/${gcp.projectId}/secrets/${name}/versions/latest`,
  });
  const data = version.payload?.data?.toString();
  if (!data) throw new Error(`Empty secret ${name}`);
  return JSON.parse(data);
}

/**
 * Read a workspace-agnostic Liveli app secret by name.
 *
 * Differs from `readConnectorSecret()` in two ways:
 *   - No tenant scoping in the name — these secrets are global to the
 *     Liveli installation (e.g. OAuth client credentials for Liveli's
 *     own apps registered with Google / Intuit). NEVER use this for
 *     per-customer data.
 *   - Returns the raw string payload, not a JSON-parsed object. The
 *     OAuth client_id / client_secret / HMAC-key secrets are stored
 *     as plain strings (created via `gcloud secrets create ... --data-file`).
 *
 * Caller is responsible for trimming whitespace if their consumer
 * cares — some Secret Manager UIs trail a newline on create.
 */
export async function readLiveliAppSecret(name: string): Promise<string> {
  const client = await smReady();
  const [version] = await client.accessSecretVersion({
    name: `projects/${gcp.projectId}/secrets/${name}/versions/latest`,
  });
  const data = version.payload?.data?.toString();
  if (!data) throw new Error(`Empty secret ${name}`);
  return data;
}

/**
 * Read the HMAC key used to sign OAuth `state` blobs.
 *
 * Separated from `readLiveliAppSecret()` because the consumer wants a
 * Buffer (HMAC inputs are bytes, not strings) — easier to centralise
 * the encoding here than have every caller deal with `Buffer.from(...)`.
 *
 * Secret was created via:
 *   openssl rand -base64 32 | gcloud secrets create liveli-oauth-state-hmac-key --data-file=-
 *
 * 32 bytes (256 bit) of entropy, base64-encoded → ~44 chars stored.
 * We base64-decode back to the raw 32-byte buffer for HMAC-SHA256.
 */
export async function readOauthStateHmacKey(): Promise<Buffer> {
  const raw = await readLiveliAppSecret("liveli-oauth-state-hmac-key");
  return Buffer.from(raw.trim(), "base64");
}

/**
 * Delete the connector secret entirely (all versions). Idempotent —
 * NotFound is treated as success so deletes are safe to retry.
 */
export async function deleteConnectorSecret(
  orgId: string,
  connectorId: string
): Promise<void> {
  const name = connectorSecretName(orgId, connectorId);
  const client = await smReady();
  try {
    await client.deleteSecret({
      name: `projects/${gcp.projectId}/secrets/${name}`,
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 5) throw err; // 5 = NOT_FOUND, treat as already-deleted
  }
}
