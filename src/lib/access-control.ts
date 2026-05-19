/**
 * Early-access email allowlist.
 *
 * While we're in private testing, we only let two specific addresses
 * complete sign-up. Anyone else who tries:
 *   - Clerk Dashboard "Restrictions → Allowed email addresses" blocks
 *     them at the sign-up form (best UX — user sees the rejection
 *     before they get an account).
 *   - This module is the SECONDARY defense: the user.created webhook
 *     deletes any Clerk user whose email isn't on the allowlist, so
 *     even if the dashboard restriction is misconfigured or bypassed,
 *     we never end up with phantom accounts in Liveli.
 *
 * To LIFT the restriction for public launch:
 *   - Remove the LIVELI_ALLOWED_EMAILS env var from Vercel (or leave
 *     empty) — that switches isEmailAllowed() into "allow everyone"
 *     mode.
 *   - Disable the Clerk Dashboard restriction.
 *   - Tracked in Linear: see "Remove email allowlist for launch".
 */

const ALLOWED = (process.env.LIVELI_ALLOWED_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Returns true if the given email is allowed to use Liveli right now.
 * Empty allowlist == public mode == everyone allowed.
 */
export function isEmailAllowed(email: string | undefined | null): boolean {
  if (!ALLOWED.length) return true;
  if (!email) return false;
  return ALLOWED.includes(email.toLowerCase());
}

/** Exported for diagnostic logging — never serialize to the client. */
export const allowlistSize = ALLOWED.length;
