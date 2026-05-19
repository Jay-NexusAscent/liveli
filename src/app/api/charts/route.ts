import { FieldValue } from "@google-cloud/firestore";
import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { dbReady, chartsIn } from "@/lib/firestore";

export const runtime = "nodejs";

const SaveBody = z.object({
  title: z.string().min(1).max(120),
  spec: z.unknown(),
  chatId: z.string().optional(),
});

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
  const snap = await chartsIn(ctx.clientId, ctx.workspaceId)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return Response.json({ items });
}

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

  const body = SaveBody.parse(await req.json());
  await dbReady();
  const doc = chartsIn(ctx.clientId, ctx.workspaceId).doc();
  await doc.set({
    title: body.title,
    spec: body.spec,
    chatId: body.chatId ?? null,
    createdBy: ctx.userId,
    createdAt: FieldValue.serverTimestamp(),
  });
  return Response.json({ id: doc.id });
}
