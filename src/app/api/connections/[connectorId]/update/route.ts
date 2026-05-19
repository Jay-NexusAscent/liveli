import { FieldValue } from "@google-cloud/firestore";
import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { connectorsIn, dbReady } from "@/lib/firestore";
import { storeConnectorSecret } from "@/lib/secret-manager";
import { logUsageEvent } from "@/lib/usage";
import { upsertSyncJob, type SyncFrequency } from "@/lib/cloud-scheduler";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Update an existing connector. Two kinds of updates:
 *   - Metadata (name, sync frequency, schemas) — Firestore write only.
 *   - Credentials (host, port, user, password, database, ssl) — new
 *     Secret Manager version + Firestore field refresh.
 *
 * Either kind, neither kind, or both can be included in one request.
 * Empty body is a no-op (returns 200 ok).
 *
 * The current connector type is unchangeable — to switch source type
 * you delete + reconnect.
 */
const Body = z.object({
  name: z.string().min(1).max(120).optional(),
  syncFrequency: z
    .enum(["5m", "15m", "30m", "1h", "6h", "12h", "24h"])
    .optional(),
  schemas: z.string().min(1).max(255).optional(),

  // Credentials — all required together when any are present.
  credentials: z
    .object({
      host: z.string().min(1).max(255),
      port: z.coerce.number().int().min(1).max(65535).default(5432),
      database: z.string().min(1).max(128),
      user: z.string().min(1).max(128),
      password: z.string().min(1).max(512),
      ssl: z.boolean().default(true),
    })
    .optional(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ connectorId: string }> }
) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const { connectorId } = await context.params;

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
  const ref = connectorsIn(ctx.clientId, ctx.workspaceId).doc(connectorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }
  const existing = snap.data() as {
    type: string;
    secretRef?: string;
    syncFrequency?: SyncFrequency;
  };

  // Build the Firestore patch.
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.syncFrequency !== undefined) patch.syncFrequency = body.syncFrequency;
  if (body.schemas !== undefined) patch.schemas = body.schemas;

  // Credentials — overwrite the Secret Manager payload with a new
  // version (the secret name is stable per connector, versioning gives
  // us rollback if needed). Also mirror the non-sensitive parts into
  // Firestore so the connect-time UI can show "host/port/user" without
  // touching the secret.
  if (body.credentials) {
    const c = body.credentials;
    patch.host = c.host;
    patch.port = c.port;
    patch.database = c.database;
    patch.user = c.user;
    patch.ssl = c.ssl;

    const secretRef = await storeConnectorSecret(ctx.clientId, connectorId, {
      host: c.host,
      port: String(c.port),
      database: c.database,
      user: c.user,
      password: c.password,
      ssl: c.ssl ? "true" : "false",
      schemas: body.schemas ?? "public",
    });
    patch.secretRef = secretRef;

    // Clear any previous error since the user has actively changed
    // credentials — they expect a fresh attempt to work.
    patch.lastError = FieldValue.delete();
    patch.status = "configured";
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ ok: true, updated: connectorId, noChanges: true });
  }

  await ref.update(patch);

  // Always re-upsert the Cloud Scheduler job on save. This is the
  // recovery path for connectors that pre-date scheduler wiring (no
  // job ever created) or whose initial upsert silently failed —
  // before this, Edit→Save was a no-op for Scheduler unless the user
  // also changed the frequency, leaving the connector unsyncable
  // short of delete+recreate. upsertSyncJob is idempotent.
  const effectiveFrequency: SyncFrequency =
    body.syncFrequency ?? existing.syncFrequency ?? "1h";
  await upsertSyncJob({
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    connectorId,
    syncFrequency: effectiveFrequency,
  });

  logUsageEvent({
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    eventType: "connector.create", // closest existing type — TODO add connector.update
    resource: connectorId,
    labels: {
      type: existing.type,
      changed: Object.keys(patch).join(","),
    },
  });

  return Response.json({ ok: true, updated: connectorId });
}
