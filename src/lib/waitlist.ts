import { clerkClient } from "@clerk/nextjs/server";
import { FieldValue } from "@google-cloud/firestore";
import { dbReady, waitlist } from "@/lib/firestore";

/**
 * Self-serve signup cap. When the number of provisioned accounts reaches
 * this number, the /sign-up page swaps from Clerk's <SignUp> form to a
 * waitlist email-capture form. Lets us throttle how many users onboard
 * during private testing.
 *
 *   - unset / "0" → unlimited (cap disabled, signup always open)
 *   - any positive integer → that many accounts, then waitlist
 *
 * Defaults to 2 so the gate is live without extra Vercel config — the
 * two test accounts already in the system trip it immediately. Raise it
 * (or set 0) to open registration back up.
 */
export const SIGNUP_CAP = (() => {
  const raw = process.env.LIVELI_SIGNUP_CAP ?? "2";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

/**
 * Whether self-serve registration is currently open.
 *
 * Counts users straight from Clerk — the authoritative source of "how
 * many accounts exist". We deliberately do NOT count the Firestore
 * `users` mirror: that doc is only written by the user.created webhook,
 * so accounts created before the webhook existed (or any missed event)
 * under-count and the gate never trips. Clerk's own count has no such
 * gap. Registration is open while the total is below the cap.
 *
 * Fail-open: if the count call throws (transient Clerk error), we return
 * `true` so an outage never traps every visitor on the waitlist. The cap
 * is a soft throttle, not a security boundary — the email allowlist +
 * Clerk remain the hard gates.
 */
export async function registrationOpen(): Promise<boolean> {
  if (SIGNUP_CAP === 0) return true;
  try {
    const cc = await clerkClient();
    const total = await cc.users.getCount();
    return total < SIGNUP_CAP;
  } catch (err) {
    console.error("[waitlist] registrationOpen count failed — failing open", {
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/**
 * Record a prospective user's interest. Keyed by lowercased email so a
 * repeat submit updates the existing row rather than creating a
 * duplicate. `createdAt` is only stamped on first insert; `updatedAt`
 * tracks the latest submit.
 */
export async function addToWaitlist(
  email: string,
  meta?: { source?: string }
): Promise<void> {
  const id = email.trim().toLowerCase();
  await dbReady();
  const ref = waitlist().doc(id);
  const existing = await ref.get();
  await ref.set(
    {
      email: id,
      source: meta?.source ?? "sign-up",
      updatedAt: FieldValue.serverTimestamp(),
      // Only stamp createdAt on first insert so it records when they
      // actually joined, not their most recent re-submit.
      ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true }
  );
}
