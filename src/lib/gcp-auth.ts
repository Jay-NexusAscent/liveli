import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Ensure GCP SDKs have credentials available before the first call.
 *
 *  - **Local dev:** relies on the user's `gcloud auth application-default
 *    login` ADC. GOOGLE_APPLICATION_CREDENTIALS may also point at a
 *    service-account JSON file if set in `.env.local`.
 *
 *  - **Vercel prod:** `GCP_SA_KEY_JSON` env var holds the full SA key
 *    JSON contents (escaped). We write it to /tmp at first call and
 *    point GOOGLE_APPLICATION_CREDENTIALS at the path. /tmp is writable
 *    on Vercel functions; the file lives for the duration of the
 *    instance, which is much longer than a single request.
 *
 *  Future hardening: swap to Workload Identity Federation
 *  (VERCEL_OIDC_TOKEN + ExternalAccountClient) so no SA key ever lives
 *  in env. Tracked as a post-demo Linear issue.
 */

let initialised = false;

export async function ensureGcpAuth(): Promise<void> {
  if (initialised) return;
  initialised = true;

  // ADC already configured (local dev or some other env that set it)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;

  const keyJson = process.env.GCP_SA_KEY_JSON;
  if (!keyJson) {
    // No SA key in env, no ADC path set — SDKs will fall back to ADC
    // discovery (works on GCE/Cloud Run but NOT Vercel). Logging once.
    if (process.env.VERCEL) {
      console.warn(
        "[gcp-auth] No GCP_SA_KEY_JSON env var set on Vercel. GCP API calls will fail."
      );
    }
    return;
  }

  const tmpDir = os.tmpdir();
  const keyPath = path.join(tmpDir, "gcp-sa-key.json");
  await fs.writeFile(keyPath, keyJson, { encoding: "utf-8", mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
}
