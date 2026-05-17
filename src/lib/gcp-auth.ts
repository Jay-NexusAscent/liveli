import { promises as fs } from "node:fs";

/**
 * Make GCP credentials available before the first SDK call.
 *
 *  - **Local dev** — no-op. The user runs `gcloud auth application-default
 *    login` once and ADC discovery finds the credentials automatically.
 *
 *  - **Vercel prod** — Workload Identity Federation. Vercel auto-injects
 *    `VERCEL_OIDC_TOKEN` on every function invocation. We:
 *      1. Write that token to /tmp/vercel-oidc-token (refreshed each call)
 *      2. Write an `external_account` credentials JSON to /tmp/gcp-wif-creds.json
 *         that references the token file via `credential_source.file`
 *      3. Set GOOGLE_APPLICATION_CREDENTIALS to that JSON path
 *
 *    The Google Cloud SDKs (BigQuery, Firestore, Vertex AnthropicVertex)
 *    then discover the creds through ADC and exchange the OIDC token at
 *    GCP STS for short-lived access tokens that impersonate
 *    `liveli-runtime@`. Zero long-lived SA keys.
 *
 *  Required Vercel env vars (already set):
 *    GCP_WORKLOAD_IDENTITY_PROVIDER  — full provider resource path
 *    GCP_RUNTIME_SERVICE_ACCOUNT     — email of the SA to impersonate
 *
 *  Required Vercel project setting:
 *    Settings → Security → OIDC Federation: enabled
 */

const TOKEN_FILE = "/tmp/vercel-oidc-token";
const CREDS_FILE = "/tmp/gcp-wif-creds.json";

let credsWritten = false;

export async function ensureGcpAuth(): Promise<void> {
  if (!process.env.VERCEL) return;

  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      "VERCEL_OIDC_TOKEN not present at runtime. Enable Function OIDC under " +
        "Vercel Project Settings → Security."
    );
  }

  // Token rotates per invocation — always refresh
  await fs.writeFile(TOKEN_FILE, token, { encoding: "utf-8", mode: 0o600 });

  if (credsWritten) return;

  const audience = process.env.GCP_WORKLOAD_IDENTITY_PROVIDER;
  const sa = process.env.GCP_RUNTIME_SERVICE_ACCOUNT;
  if (!audience || !sa) {
    throw new Error(
      "GCP_WORKLOAD_IDENTITY_PROVIDER and GCP_RUNTIME_SERVICE_ACCOUNT must be set on Vercel."
    );
  }

  // Normalise audience to STS-expected `//iam.googleapis.com/...` form
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
