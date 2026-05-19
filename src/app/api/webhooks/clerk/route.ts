import { Webhook } from "svix";
import { clerkClient } from "@clerk/nextjs/server";
import { ensureClient } from "@/lib/clients";
import { dbReady, userDoc } from "@/lib/firestore";
import { isEmailAllowed } from "@/lib/access-control";
import { FieldValue } from "@google-cloud/firestore";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Clerk webhook → eagerly provisions Client + default Workspace at the
 * moment a Clerk Organization is created, so the user has a working
 * tenant before they hit the app for the first time.
 *
 * Replaces the lazy provisioning that lived in requireWorkspaceContext()
 * (which is kept as a fallback for any pre-webhook orgs and as a
 * defensive idempotent path).
 *
 * Setup checklist:
 *   1. In Clerk Dashboard → Webhooks → Add Endpoint
 *      URL: https://app.liveli.co.uk/api/webhooks/clerk
 *      Events: organization.created, user.created, organization.deleted
 *   2. Copy the Signing Secret, set as CLERK_WEBHOOK_SECRET in Vercel
 *      production env.
 */

interface ClerkOrgCreatedEvent {
  type: "organization.created";
  data: {
    id: string;
    name: string;
    created_by: string;
    created_at: number;
  };
}

interface ClerkUserCreatedEvent {
  type: "user.created";
  data: {
    id: string;
    email_addresses: Array<{ email_address: string; id: string }>;
    primary_email_address_id?: string;
    first_name?: string;
    last_name?: string;
  };
}

interface ClerkOrgDeletedEvent {
  type: "organization.deleted";
  data: {
    id: string;
    deleted: boolean;
  };
}

interface ClerkUserDeletedEvent {
  type: "user.deleted";
  data: {
    id: string;
    deleted: boolean;
  };
}

type ClerkEvent =
  | ClerkOrgCreatedEvent
  | ClerkUserCreatedEvent
  | ClerkOrgDeletedEvent
  | ClerkUserDeletedEvent
  | { type: string; data: Record<string, unknown> };

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[clerk-webhook] CLERK_WEBHOOK_SECRET not set");
    return Response.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Svix headers — required for signature verification. Missing means
  // the request didn't come from Clerk and must be rejected.
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return Response.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const body = await req.text();
  let event: ClerkEvent;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkEvent;
  } catch (err) {
    console.error("[clerk-webhook] signature verify failed", err);
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "organization.created":
        await handleOrgCreated(event as ClerkOrgCreatedEvent);
        break;
      case "user.created":
        await handleUserCreated(event as ClerkUserCreatedEvent);
        break;
      case "organization.deleted":
        await handleOrgDeleted(event as ClerkOrgDeletedEvent);
        break;
      case "user.deleted":
        await handleUserDeleted(event as ClerkUserDeletedEvent);
        break;
      default:
        // We don't subscribe to other events but Clerk may send some
        // anyway. Acknowledge so they're not retried indefinitely.
        break;
    }
    return Response.json({ ok: true, type: event.type });
  } catch (err) {
    console.error("[clerk-webhook] handler threw", {
      type: event.type,
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Return 500 so Clerk retries.
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * On Clerk Organization create, provision the Client doc + default
 * Workspace eagerly. Idempotent — ensureClient handles the case where
 * a doc was already created (e.g. by a lazy-fallback request that
 * happened to fire before the webhook arrived).
 */
async function handleOrgCreated(event: ClerkOrgCreatedEvent): Promise<void> {
  await ensureClient(event.data.id, event.data.created_by, {
    name: event.data.name || "Workspace",
  });
  console.log("[clerk-webhook] provisioned client", {
    clientId: event.data.id,
    createdBy: event.data.created_by,
  });
}

/**
 * Mirror Clerk user metadata into Firestore. We don't store passwords
 * or auth state — Clerk owns that. We just keep email + name for joins
 * and for usage_events.userId lookups.
 *
 * Email allowlist enforcement: if the user's email isn't on the
 * LIVELI_ALLOWED_EMAILS env var (private testing mode), we delete
 * the freshly-created Clerk user immediately. This is the secondary
 * defense — the primary defense is Clerk Dashboard's "Allowed email
 * addresses" restriction, which blocks at the sign-up form.
 */
async function handleUserCreated(event: ClerkUserCreatedEvent): Promise<void> {
  const primary = event.data.email_addresses.find(
    (e) => e.id === event.data.primary_email_address_id
  );
  const email =
    primary?.email_address ?? event.data.email_addresses[0]?.email_address;

  if (!isEmailAllowed(email)) {
    // Outside the allowlist — purge the user so they can't access anything.
    console.warn("[clerk-webhook] purging user outside allowlist", {
      userId: event.data.id,
      email,
    });
    try {
      const cc = await clerkClient();
      await cc.users.deleteUser(event.data.id);
    } catch (err) {
      console.error("[clerk-webhook] failed to purge user", {
        userId: event.data.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // Don't mirror to Firestore — the user shouldn't exist on our side.
    return;
  }

  await dbReady();
  await userDoc(event.data.id).set(
    {
      email,
      firstName: event.data.first_name,
      lastName: event.data.last_name,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * On Clerk Organization delete, tear down the Client's data. Uses the
 * same deletion path as the user-initiated account-delete API route
 * (see /api/account/delete) so both code paths converge.
 *
 * IMPORTANT: this fires whenever a Clerk org is deleted, including via
 * admin actions. Treat it as the authoritative "wipe this Client" signal.
 */
async function handleOrgDeleted(event: ClerkOrgDeletedEvent): Promise<void> {
  // Import inline to avoid pulling delete-account dependencies into
  // every webhook invocation when other events fire.
  const { deleteClient } = await import("@/lib/clients");
  await deleteClient(event.data.id, { reason: "clerk:organization.deleted" });
}

/**
 * On Clerk User delete, remove our users/{userId} mirror doc. The
 * organization.deleted webhook handles wiping the actual workspace
 * data — this is just cleanup of the auth-mirror record.
 */
async function handleUserDeleted(event: ClerkUserDeletedEvent): Promise<void> {
  await dbReady();
  try {
    await userDoc(event.data.id).delete();
    console.log("[clerk-webhook] deleted user mirror", { userId: event.data.id });
  } catch (err) {
    // .delete() is idempotent on Firestore (no-op if doc doesn't exist),
    // so any throw here is unexpected — log loud.
    console.error("[clerk-webhook] failed to delete user mirror", {
      userId: event.data.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
