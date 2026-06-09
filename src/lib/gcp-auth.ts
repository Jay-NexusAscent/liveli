import { promises as fs } from "node:fs";
import { getVercelOidcToken } from "@vercel/oidc";

/**
 * Make GCP credentials available before the first SDK call.
 *
 *  - **Local dev** — no-op. The user runs `gcloud auth application-default
 *    login` once and ADC discovery finds the credentials automatically.
 *
 *  - **Vercel prod** — Workload Identity Federation.
 *
 *    The Vercel OIDC token is fetched via `@vercel/oidc`'s
 *    `getVercelOidcToken()` — this transparently handles both delivery
 *    mechanisms (env var on legacy runtimes, request-context headers
 *    on Fluid Compute / modern Next.js App Router). Reading
 *    `process.env.VERCEL_OIDC_TOKEN` directly is *unreliable* on
 *    current Vercel — it's commonly undefined even when OIDC is
 *    enabled. Always use the package.
 *
 *    On each invocation we:
 *      1. Fetch the per-request OIDC token via getVercelOidcToken()
 *      2. Write it to /tmp/vercel-oidc-token
 *      3. On first call, write an external_account credentials JSON to
 *         /tmp/gcp-wif-creds.json that references the token file via
 *         credential_source.file
 *      4. Set GOOGLE_APPLICATION_CREDENTIALS to that JSON path
 *
 *    Google Cloud SDKs (BigQuery, Firestore, Vertex AI)
 *    discover the credentials through ADC and exchange the token at
 *    GCP STS for a short-lived access token impersonating
 *    `liveli-runtime@`. Zero long-lived SA keys.
 */

const TOKEN_FILE = "/tmp/vercel-oidc-token";
const CREDS_FILE = "/tmp/gcp-wif-creds.json";

let credsWritten = false;

export async function ensureGcpAuth(): Promise<void> {
  if (!process.env.VERCEL) return;

  let token: string | undefined;
  try {
    token = await getVercelOidcToken();
  } catch (err) {
    throw new Error(
      `getVercelOidcToken() threw: ${err instanceof Error ? err.message : String(err)}. ` +
        "Confirm Vercel Project Settings → Security → Function OIDC is enabled and the function was deployed after enabling it."
    );
  }

  if (!token) {
    throw new Error(
      "getVercelOidcToken() returned empty. OIDC token not available in this runtime context."
    );
  }

  // Refresh token file each invocation (token rotates per request).
  await fs.writeFile(TOKEN_FILE, token, { encoding: "utf-8", mode: 0o600 });

  if (credsWritten) return;

  const audience = process.env.GCP_WORKLOAD_IDENTITY_PROVIDER;
  const sa = process.env.GCP_RUNTIME_SERVICE_ACCOUNT;
  if (!audience || !sa) {
    throw new Error(
      "GCP_WORKLOAD_IDENTITY_PROVIDER and GCP_RUNTIME_SERVICE_ACCOUNT must be set on Vercel."
    );
  }

  const normalisedAudience = audience.startsWith("//")
    ? audience
    : `//iam.googleapis.com/${audience.replace(/^\/+/, "")}`;

  const credentials = {
    type: "external_account",
    audience: normalisedAudience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`,
    credential_source: {
      file: TOKEN_FILE,
      format: { type: "text" },
    },
  };

  await fs.writeFile(CREDS_FILE, JSON.stringify(credentials), {
    encoding: "utf-8",
    mode: 0o600,
  });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = CREDS_FILE;
  credsWritten = true;
}
