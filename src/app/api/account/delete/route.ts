import { auth, clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { deleteClient } from "@/lib/clients";
import { clientDoc, dbReady } from "@/lib/firestore";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  /**
   * Confirmation string. The user has to type their Clerk org name
   * exactly. Anything else rejects.
   */
  confirmName: z.string().min(1),
});

/**
 * Permanently delete the current Client and all of its data.
 *
 * Flow:
 *   1. Require auth + active org (the Clerk org context).
 *   2. Load the Client doc to compare confirmName against the stored
 *      name — prevents accidental deletes via copy-paste of a wrong
 *      curl.
 *   3. deleteClient() — drops BQ datasets, Secret Manager secrets,
 *      Firestore connector/chat/chart/dashboard docs, workspace docs,
 *      then the Client doc. A snapshot lands in billing_history first.
 *   4. Delete the Clerk Organization via Clerk Backend API. The org's
 *      deletion fires our /api/webhooks/clerk handler which calls
 *      deleteClient again (idempotent — no-ops since we already wiped).
 *
 * After this returns, the user is in an "orgless" Clerk state. The
 * frontend should redirect them to /sign-in (which auto-creates a new
 * personal workspace if they sign back in, or they can join another
 * org they're a member of).
 */
export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
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

  await dbReady();
  const snap = await clientDoc(orgId).get();
  if (!snap.exists) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }
  const data = snap.data() as { name?: string };
  const expectedName = data.name ?? "";

  // Constant-time-ish comparison. The string is non-secret but the
  // confirmation pattern still benefits from explicit equality.
  if (body.confirmName.trim() !== expectedName.trim()) {
    return Response.json(
      {
        error: "Confirmation name mismatch. Type the workspace name exactly.",
        expected: expectedName,
      },
      { status: 400 }
    );
  }

  // ── Step 1+2: wipe our side ──────────────────────────────────────
  await deleteClient(orgId, {
    reason: "user-initiated",
    deletedBy: userId,
  });

  // ── Step 3: delete the Clerk Org ─────────────────────────────────
  // Clerk fires organization.deleted back to our webhook, which calls
  // deleteClient again — idempotent no-op since the doc is gone.
  try {
    const cc = await clerkClient();
    await cc.organizations.deleteOrganization(orgId);
  } catch (err) {
    // Clerk delete failed but our data is already gone. Surface but
    // don't undo — there's nothing to undo. User can retry the Clerk
    // delete manually or via support.
    console.error("[account.delete] Clerk org delete failed", {
      orgId,
      err: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      {
        ok: true,
        warning:
          "Workspace data deleted, but Clerk organization could not be removed. Contact support.",
      },
      { status: 200 }
    );
  }

  return Response.json({ ok: true, deleted: orgId });
}
