import { auth } from "@clerk/nextjs/server";
import { FieldValue } from "@google-cloud/firestore";
import { z } from "zod";
import { dbReady, charts } from "@/lib/firestore";

export const runtime = "nodejs";

const SaveBody = z.object({
  title: z.string().min(1).max(120),
  spec: z.unknown(),
  chatId: z.string().optional(),
});

export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbReady();
  const snap = await charts(orgId).orderBy("createdAt", "desc").limit(100).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return Response.json({ items });
}

export async function POST(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = SaveBody.parse(await req.json());
  await dbReady();
  const doc = charts(orgId).doc();
  await doc.set({
    title: body.title,
    spec: body.spec,
    chatId: body.chatId ?? null,
    createdBy: userId,
    createdAt: FieldValue.serverTimestamp(),
  });
  return Response.json({ id: doc.id });
}
