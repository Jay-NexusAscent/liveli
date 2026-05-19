import { auth, clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { deleteClient } from "@/lib/clients";
import { clientDoc, dbReady } from "@/lib/firestore";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  /** Type the user's email exactly to confirm intent. */
  confirmEmail: z.string().min(1),
  /**
   * If true (default), data wipe is IMMEDIATE — Liveli data + Clerk org +
   * Clerk user are all torn down right now. Useful while we're pre-launch
   * and don't need the 30-day grace period.
   *
   * The grace-period flow (LIVELI-75) will introduce mode: "scheduled"
   * which schedules deletion for now+30d and pauses syncs in the meantime.
   */
  mode: z.enum(["immediate", "scheduled"]).default("immediate"),
});

/**
 * Delete the customer's account and ALL their data.
 *
 * "immediate" mode (current behaviour):
 *   1. Authenticate the user + their active org.
 *   2. Match confirmEmail against the user's Clerk primary email.
 *   3. deleteClient() — wipes Firestore + BQ + Secret Manager, snapshots
 *      billing history.
 *   4. Delete the Clerk Organization (fires our org.deleted webhook —
 *      idempotent, no-ops since the Firestore client doc is gone).
 *   5. Delete the Clerk User (fires our user.deleted webhook which
 *      cleans the users/{userId} mirror doc).
 *
 * After step 5 the user is fully logged out. Frontend should redirect
 * to the marketing landing page.
 *
 * "scheduled" mode (TODO LIVELI-75): mark for deletion, pause syncs,
 * email customer, sign them out — daily cron purges after 30 days.
 */
export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  // Verify confirmEmail matches the user's primary email — primary
  // defense against accidental deletes via a stale tab or curl.
  const cc = await clerkClient();
  const clerkUser = await cc.users.getUser(userId);
  const primaryEmail = clerkUser.emailAddresses.find(
    (e) => e.id === clerkUser.primaryEmailAddressId
  )?.emailAddress;

  if (!primaryEmail) {
    return Response.json({ error: "No primary email on account" }, { status: 400 });
  }
  if (body.confirmEmail.trim().toLowerCase() !== primaryEmail.toLowerCase()) {
    return Response.json(
      { error: "Confirmation email doesn't match the email on your account." },
      { status: 400 }
    );
  }

  if (body.mode === "scheduled") {
    // Placeholder for the grace-period flow. Not yet implemented —
    // see LIVELI-75. Reject so callers know it's not available.
    return Response.json(
      {
        error:
          "Scheduled deletion (30-day grace period) is not yet available. Use mode: 'immediate' or wait for the grace-period feature.",
      },
      { status: 501 }
    );
  }

  // ── Immediate teardown ───────────────────────────────────────────
  await dbReady();

  // Wipe Liveli data for the active org (if any). User may not have an
  // org if they already deleted their workspace and are now deleting
  // their account — that's fine, just skip.
  if (orgId) {
    const snap = await clientDoc(orgId).get();
    if (snap.exists) {
      await deleteClient(orgId, {
        reason: "user-initiated:account-delete",
        deletedBy: userId,
      });
    }
  }

  // Delete the Clerk Organization (if any).
  if (orgId) {
    try {
      await cc.organizations.deleteOrganization(orgId);
    } catch (err) {
      console.error("[account.delete] Clerk org delete failed", {
        orgId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Continue — we still want to delete the user.
    }
  }

  // Delete the Clerk User — fires user.deleted webhook which cleans
  // up our users/{userId} mirror doc.
  try {
    await cc.users.deleteUser(userId);
  } catch (err) {
    console.error("[account.delete] Clerk user delete failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      {
        ok: false,
        warning:
          "Workspace data deleted, but your account couldn't be removed. Contact support to finish closing the account.",
      },
      { status: 200 }
    );
  }

  return Response.json({ ok: true, deleted: { userId, orgId } });
}
