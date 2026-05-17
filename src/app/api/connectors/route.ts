import { auth } from "@clerk/nextjs/server";
import { dbReady, connectors } from "@/lib/firestore";

export const runtime = "nodejs";

export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbReady();
  const snap = await connectors(orgId).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return Response.json({ items });
}
