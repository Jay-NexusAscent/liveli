import { auth } from "@clerk/nextjs/server";
import { FieldValue, type Timestamp } from "@google-cloud/firestore";
import { clientDoc, dbReady, workspacesIn } from "@/lib/firestore";

export interface ClientDoc {
  /** Display name. Defaults to "Workspace" for self-serve signup; can be set later. */
  name?: string;
  /** Pointer to the workspace auto-created when the Client was provisioned. */
  defaultWorkspaceId: string;
  /**
   * Per-client service account email. Set when SA provisioning runs
   * (Phase 1 commit 3). For Phase 2 the runtime impersonates this SA
   * for all BigQuery operations scoped to this Client.
   */
  serviceAccountEmail?: string;
  createdAt: Timestamp;
  createdBy?: string;
  billing?: {
    stripeCustomerId?: string;
    plan?: "free" | "starter" | "pro" | "enterprise";
  };
}

export interface WorkspaceDoc {
  name: string;
  /** "EU" or "US" multi-region. Picked at workspace creation, immutable. */
  bqLocation: "EU" | "US";
  isDefault?: boolean;
  createdAt: Timestamp;
  createdBy?: string;
}

export interface WorkspaceContext {
  userId: string;
  clientId: string;
  workspaceId: string;
}

/**
 * Custom error so route handlers can catch and return 401 cleanly.
 */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Extract (clientId, workspaceId, userId) from the Clerk session.
 * Lazy-provisions the Client doc + default workspace if this is the
 * first time we've seen this Clerk org. Use in every API route that
 * needs tenant context.
 *
 * For Phase 1, every request that lacks the Client doc triggers
 * provisioning. Once the Clerk org.created webhook is live (commit 3
 * of this migration), that becomes the primary provisioning path
 * and this stays as the fallback for any pre-webhook orgs.
 */
export async function requireWorkspaceContext(): Promise<WorkspaceContext> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    throw new UnauthorizedError();
  }
  const { workspaceId } = await ensureClient(orgId, userId);
  return { userId, clientId: orgId, workspaceId };
}

/**
 * Idempotently ensure a Client doc + default Workspace exist for the
 * given Clerk org. Returns the (clientId, workspaceId) pair.
 *
 * Runs inside a Firestore transaction so concurrent first-request
 * traffic can't create duplicate workspaces.
 */
export async function ensureClient(
  clientId: string,
  userId: string,
  opts: { name?: string; bqLocation?: "EU" | "US" } = {}
): Promise<{ clientId: string; workspaceId: string }> {
  const db = await dbReady();
  const ref = clientDoc(clientId);

  // Fast path: doc already exists with a valid defaultWorkspaceId.
  const initial = await ref.get();
  if (initial.exists) {
    const data = initial.data() as ClientDoc;
    if (data.defaultWorkspaceId) {
      return { clientId, workspaceId: data.defaultWorkspaceId };
    }
  }

  // Slow path: create or repair atomically.
  const workspaceRef = workspacesIn(clientId).doc();
  const workspaceId = workspaceRef.id;

  await db.runTransaction(async (tx) => {
    const txSnap = await tx.get(ref);

    // Double-check inside the transaction — another request may have
    // raced us between the fast-path read and this transaction.
    if (txSnap.exists) {
      const data = txSnap.data() as ClientDoc;
      if (data.defaultWorkspaceId) {
        // Already provisioned by a concurrent request. Bail out — the
        // outer return below will report the wrong workspaceId, so we
        // need a different signal. Use a sentinel field set on `this`.
        // Easiest: throw and let the caller retry the fast path.
        throw new AlreadyProvisionedError(data.defaultWorkspaceId);
      }
    }

    // The typed *Doc interfaces describe the READ shape (Timestamp on
    // createdAt). At write time we pass FieldValue.serverTimestamp(),
    // which Firestore resolves server-side. Don't `satisfies` the typed
    // shape here — it'd reject the FieldValue.
    tx.set(
      ref,
      {
        name: opts.name ?? "Workspace",
        defaultWorkspaceId: workspaceId,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: userId,
        billing: { plan: "free" },
      },
      { merge: true }
    );

    tx.set(workspaceRef, {
      name: "Default workspace",
      bqLocation: opts.bqLocation ?? "EU",
      isDefault: true,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: userId,
    });
  }).catch(async (err) => {
    if (err instanceof AlreadyProvisionedError) {
      // Swallow — return the concurrent winner's workspaceId.
      return;
    }
    throw err;
  });

  // Re-read to pick up the concurrent-winner case.
  const final = await ref.get();
  const data = final.data() as ClientDoc | undefined;
  return {
    clientId,
    workspaceId: data?.defaultWorkspaceId ?? workspaceId,
  };
}

class AlreadyProvisionedError extends Error {
  constructor(public readonly workspaceId: string) {
    super("client already provisioned");
  }
}

/**
 * Look up the Client's default workspace ID. Returns null if the
 * Client doc doesn't exist yet (caller can decide whether to
 * provision or 404).
 */
export async function getDefaultWorkspaceId(clientId: string): Promise<string | null> {
  await dbReady();
  const snap = await clientDoc(clientId).get();
  if (!snap.exists) return null;
  const data = snap.data() as ClientDoc;
  return data.defaultWorkspaceId ?? null;
}
