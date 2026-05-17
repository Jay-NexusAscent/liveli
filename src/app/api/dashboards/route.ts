import { auth } from "@clerk/nextjs/server";
import { dbReady, dashboards } from "@/lib/firestore";

export const runtime = "nodejs";

export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await dbReady();
  const snap = await dashboards(orgId).orderBy("createdAt", "desc").limit(50).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return Response.json({ items });
}
