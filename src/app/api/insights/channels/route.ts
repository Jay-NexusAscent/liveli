import { z } from "zod";
import { FieldValue } from "@google-cloud/firestore";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { alertChannelsIn, dbReady } from "@/lib/firestore";
import { redactChannelConfig } from "@/lib/insights/notify";
import type {
  AlertChannel,
  AlertChannelConfig,
  AlertChannelPublic,
} from "@/lib/insights/notify";

export const runtime = "nodejs";

/**
 * List all alert channels for the current workspace. Returns the
 * REDACTED view — secrets (webhook URLs, bot tokens) are masked.
 * Full secrets only flow on the POST path (create) and never come
 * back to clients. Editing a channel re-issues the secret via PATCH.
 *
 * Ordered newest-first to match the rest of the workspace surface.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  await dbReady();
  const snap = await alertChannelsIn(ctx.clientId, ctx.workspaceId)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  const items: AlertChannelPublic[] = snap.docs.map((d) => {
    const raw = { id: d.id, ...d.data() } as AlertChannel;
    return {
      id: raw.id,
      type: raw.type,
      name: raw.name,
      enabled: raw.enabled,
      configPreview: redactChannelConfig(raw.config),
      lastSentAt: raw.lastSentAt ?? null,
      lastSendError: raw.lastSendError ?? null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt ?? null,
    };
  });

  return Response.json({ items });
}

/**
 * Discriminated-union body schema. Same shape as save_insight pattern
 * — one z.object per channel type with the type-specific required
 * fields; z.discriminatedUnion picks the right one based on `type`.
 *
 * Why z.discriminatedUnion works here but not for agent tool inputs:
 * this endpoint is hit by the UI's CHANNEL form (one type at a time),
 * not the Gemini schema-proto layer. zod discriminated unions are
 * fine for HTTP route validation; only Gemini's Schema proto rejects
 * them.
 */
const PostBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("slack"),
    name: z.string().min(1).max(80),
    enabled: z.boolean().optional().default(true),
    webhookUrl: z.string().url().startsWith("https://"),
  }),
  z.object({
    type: z.literal("teams"),
    name: z.string().min(1).max(80),
    enabled: z.boolean().optional().default(true),
    webhookUrl: z.string().url().startsWith("https://"),
  }),
  z.object({
    type: z.literal("telegram"),
    name: z.string().min(1).max(80),
    enabled: z.boolean().optional().default(true),
    botToken: z.string().min(10),
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal("webhook"),
    name: z.string().min(1).max(80),
    enabled: z.boolean().optional().default(true),
    webhookUrl: z.string().url().startsWith("https://"),
    bearerSecret: z.string().min(1).optional(),
  }),
]);

/**
 * Create a new channel. The full secret (URL / token) only flows on
 * this path — never on GET. Returns the public (redacted) view so
 * the client can drop it into the list without a refetch.
 */
export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  await dbReady();

  // Project body → AlertChannel shape. The narrowing here is per-
  // type because each variant has different secret fields.
  let config: AlertChannelConfig;
  switch (body.type) {
    case "slack":
      config = { type: "slack", webhookUrl: body.webhookUrl };
      break;
    case "teams":
      config = { type: "teams", webhookUrl: body.webhookUrl };
      break;
    case "telegram":
      config = {
        type: "telegram",
        botToken: body.botToken,
        chatId: body.chatId,
      };
      break;
    case "webhook":
      config = {
        type: "webhook",
        webhookUrl: body.webhookUrl,
        ...(body.bearerSecret ? { bearerSecret: body.bearerSecret } : {}),
      };
      break;
  }

  const ref = alertChannelsIn(ctx.clientId, ctx.workspaceId).doc();
  await ref.set({
    type: body.type,
    name: body.name,
    enabled: body.enabled ?? true,
    config,
    createdBy: ctx.userId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: null,
    lastSentAt: null,
    lastSendError: null,
  });

  const fresh = (await ref.get()).data() as AlertChannel;
  return Response.json({
    ok: true,
    channel: {
      id: ref.id,
      type: fresh.type,
      name: fresh.name,
      enabled: fresh.enabled,
      configPreview: redactChannelConfig(fresh.config),
      lastSentAt: null,
      lastSendError: null,
      createdAt: fresh.createdAt,
      updatedAt: null,
    } satisfies AlertChannelPublic,
  });
}
