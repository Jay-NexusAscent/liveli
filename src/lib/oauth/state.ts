/**
 * HMAC-signed state blob for the OAuth redirect dance.
 *
 * Threat model: the `state` query param round-trips through an
 * untrusted browser. An attacker who can mint a valid state can hijack
 * the OAuth callback to bind a freshly-issued refresh_token to a
 * connector under THEIR workspace — credential theft. The HMAC + 10
 * min expiry is the defence.
 *
 * Format: `base64url(payload) + "." + base64url(hmac(payload))`.
 * Both halves are URL-safe so no URL-encoding wrapper is needed for
 * the OAuth provider redirect.
 *
 * HMAC key lives in Secret Manager under `liveli-oauth-state-hmac-key`
 * (created once via `openssl rand -base64 32` per LIVELI-132). Cached
 * in-process — the key never changes mid-deploy, and Vercel's Fluid
 * Compute reuses function instances, so one Secret Manager call per
 * cold start is the steady-state cost.
 */

import crypto from "node:crypto";
import { readOauthStateHmacKey } from "@/lib/secret-manager";
import type { OAuthStateClaims } from "@/lib/oauth/types";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — enough for human consent

/**
 * In-process cache of the HMAC key. Refreshed on cold start. Process
 * lifetime is bounded by Fluid Compute's instance lifetime (typically
 * 5-15 min idle before recycle), so even a rotated key takes effect
 * within minutes without an explicit deploy.
 */
let _hmacKey: Buffer | null = null;

async function getHmacKey(): Promise<Buffer> {
  if (_hmacKey) return _hmacKey;
  const raw = await readOauthStateHmacKey();
  if (raw.length < 16) {
    // 16-byte minimum — anything shorter, treat the secret as
    // corrupted/empty and bail rather than silently using weak crypto.
    throw new Error(
      "liveli-oauth-state-hmac-key in Secret Manager is too short (< 16 bytes). Regenerate with `openssl rand -base64 32`."
    );
  }
  _hmacKey = raw;
  return _hmacKey;
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  // Pad to multiple of 4 — base64url drops trailing `=`.
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Mint a signed state token for the OAuth start handler. The returned
 * string goes into the `state` query param of the provider redirect.
 *
 * Caller is responsible for filling every field of the claims. The
 * helper appends `nonce` (16 random bytes) and `expiresAt` (now + TTL)
 * — those are signature-bound, not caller-provided.
 */
export async function signOAuthState(
  claims: Omit<OAuthStateClaims, "nonce" | "expiresAt">,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<string> {
  const full: OAuthStateClaims = {
    ...claims,
    nonce: b64urlEncode(crypto.randomBytes(16)),
    expiresAt: Date.now() + ttlMs,
  };
  const payload = Buffer.from(JSON.stringify(full), "utf8");
  const key = await getHmacKey();
  const mac = crypto.createHmac("sha256", key).update(payload).digest();
  return `${b64urlEncode(payload)}.${b64urlEncode(mac)}`;
}

/**
 * Verify a state token from the OAuth callback and return its claims,
 * or throw if the signature is bad / token expired / format malformed.
 *
 * Why throw instead of returning null: the callback handler must
 * NEVER proceed on a bad state. A null sentinel invites a `if (!claims)
 * return error` that's easy to forget. Throwing forces the callback to
 * catch + render a user-visible error.
 */
export async function verifyOAuthState(
  token: string
): Promise<OAuthStateClaims> {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new OAuthStateError("malformed state token (expected payload.mac)");
  }
  const [payloadB64, macB64] = parts;
  let payload: Buffer;
  let mac: Buffer;
  try {
    payload = b64urlDecode(payloadB64);
    mac = b64urlDecode(macB64);
  } catch {
    throw new OAuthStateError("malformed state token (base64url decode failed)");
  }

  const key = await getHmacKey();
  const expected = crypto.createHmac("sha256", key).update(payload).digest();

  // timingSafeEqual requires equal-length buffers — guard before the
  // call, otherwise the function throws RangeError instead of returning
  // false. The length check itself isn't sensitive (the attacker
  // already knows the mac length is 32 bytes for SHA-256).
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) {
    throw new OAuthStateError("invalid state signature");
  }

  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new OAuthStateError("state payload is not valid JSON");
  }

  if (typeof claims.expiresAt !== "number" || Date.now() > claims.expiresAt) {
    throw new OAuthStateError(
      "state token expired — restart the connection flow"
    );
  }

  return claims;
}

/**
 * Dedicated error type so callback handlers can catch + render a
 * user-friendly redirect to /connections?error=oauth_state_invalid
 * without confusing the message with a downstream provisioning error.
 */
export class OAuthStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OAuthStateError";
  }
}
