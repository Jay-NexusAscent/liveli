import { auth } from "@clerk/nextjs/server";
import { FieldValue, type Timestamp } from "@google-cloud/firestore";
import {
  chartsIn,
  chatsIn,
  clientDoc,
  connectorsIn,
  dashboardsIn,
  db,
  dbReady,
  workspaceDoc,
  workspacesIn,
} from "@/lib/firestore";
import { bqReady } from "@/lib/bigquery";
import { deleteSyncJob } from "@/lib/cloud-scheduler";
import { cloudComputeRegionForResidency } from "@/lib/gcp";
import { deleteConnectorSecret } from "@/lib/secret-manager";
import {
  deleteClientState,
  deleteConnectorState,
} from "@/lib/meltano-state";

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

/**
 * Permanently delete a Client and all of its data:
 *   1. Snapshot the Client + last 12 months of usage rollups into the
 *      immutable `billing_history` collection BEFORE anything is wiped.
 *      Lets us answer "what plan were they on, when did they pay" after
 *      the customer is long gone.
 *   2. For each workspace:
 *        - Each connector: drop BQ dataset, delete Secret Manager
 *          secret, delete Firestore connector doc.
 *        - Recursive-delete chats (with messages subcollection), charts,
 *          dashboards.
 *        - Delete workspace doc.
 *   3. Delete the Client doc.
 *
 * Phase 2 will also tear down the per-client SA and Cloud Run Jobs here.
 *
 * IDEMPOTENT. Safe to call on an already-deleted Client (no-op).
 *
 * Called from:
 *   - User-initiated DELETE /api/account/delete (with double confirm)
 *   - Clerk organization.deleted webhook (no confirm — Clerk is the
 *     source of truth for org existence)
 */
export async function deleteClient(
  clientId: string,
  opts: { reason: string; deletedBy?: string } = { reason: "manual" }
): Promise<void> {
  const firestore = await dbReady();
  const ref = clientDoc(clientId);

  const snap = await ref.get();
  if (!snap.exists) {
    // Already deleted. Idempotent no-op.
    return;
  }
  const clientData = snap.data() as ClientDoc;

  // ── Step 1: snapshot to billing_history BEFORE we wipe anything ───
  await firestore
    .collection("billing_history")
    .doc(clientId)
    .collection("snapshots")
    .add({
      deletedAt: FieldValue.serverTimestamp(),
      reason: opts.reason,
      deletedBy: opts.deletedBy,
      // Plan + billing identifiers (Stripe customer ID etc.) for any
      // refund / dispute / audit need later.
      plan: clientData.billing?.plan ?? "unknown",
      stripeCustomerId: clientData.billing?.stripeCustomerId ?? null,
      clientName: clientData.name ?? null,
      clientCreatedAt: clientData.createdAt ?? null,
      clientCreatedBy: clientData.createdBy ?? null,
    });

  // ── Step 2: iterate workspaces, tear down each ────────────────────
  const wsSnap = await workspacesIn(clientId).get();
  for (const wsDoc of wsSnap.docs) {
    const workspaceId = wsDoc.id;

    // Connectors — must explicitly drop BQ dataset + Secret per connector.
    const connSnap = await connectorsIn(clientId, workspaceId).get();
    for (const connDocSnap of connSnap.docs) {
      const connectorId = connDocSnap.id;
      const connData = connDocSnap.data() as {
        bqDataset?: string;
        bqLocation?: "EU" | "US";
      };

      // Stop the recurring sync FIRST so Cloud Scheduler can't fire
      // mid-teardown (its target /api/connections/[id]/scheduled-sync
      // would still try to load the now-deleted connector doc, 404,
      // log noise + the failed-invocation Scheduler attempt is
      // tracked for 30 days in GCP audit logs — operational noise we
      // can avoid by tearing the scheduler entry down first).
      //
      // Per-connector DELETE already does this; previously deleteClient
      // (the whole-account-delete path) skipped it, leaving orphan
      // Scheduler entries behind. Closed in the LIVELI-54-followup PR.
      try {
        const { region: schedulerRegion } = cloudComputeRegionForResidency(
          connData.bqLocation
        );
        await deleteSyncJob(clientId, connectorId, schedulerRegion);
      } catch (err) {
        // deleteSyncJob is already 404-tolerant. Anything else logged
        // + swallowed — a stuck Scheduler entry is annoying but never
        // a reason to abandon the rest of the account teardown.
        console.warn("[deleteClient] deleteSyncJob failed (swallowed)", {
          clientId,
          connectorId,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      if (connData.bqDataset) {
        try {
          const bq = await bqReady();
          await bq.dataset(connData.bqDataset).delete({ force: true });
        } catch (err) {
          const code = (err as { code?: number })?.code;
          if (code !== 404) throw err;
        }
      }

      try {
        await deleteConnectorSecret(clientId, connectorId);
      } catch {
        // deleteConnectorSecret is already idempotent — swallow anything else.
      }

      // Drop the Meltano state object for this connector. Already
      // best-effort + idempotent inside the helper.
      await deleteConnectorState(clientId, workspaceId, connectorId);

      await connDocSnap.ref.delete();
    }

    // Chats (with messages subcollection), charts, dashboards.
    await firestore.recursiveDelete(chatsIn(clientId, workspaceId));
    await firestore.recursiveDelete(chartsIn(clientId, workspaceId));
    await firestore.recursiveDelete(dashboardsIn(clientId, workspaceId));

    // Workspace doc itself.
    await workspaceDoc(clientId, workspaceId).delete();
  }

  // ── Step 2b: sweep any orphaned state objects under <clientId>/ ──
  // The per-connector loop above already dropped each known
  // connector's state. This sweep catches anything left behind by
  // races (e.g. a connector deleted before this code shipped) so the
  // client is fully clean after this call.
  await deleteClientState(clientId);

  // ── Step 3: delete the Client doc ────────────────────────────────
  await ref.delete();

  // Avoid unused-warning while db() is exported for callers that need
  // the raw client; we keep the import live here for recursiveDelete.
  void db;
}
