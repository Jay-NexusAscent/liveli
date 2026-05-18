import { z } from "zod";
import { runAgentTurn } from "@/lib/agent";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { streamResponse } from "@/lib/streaming";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  message: z.string().min(1).max(4000),
  chatId: z.string().optional(),
});

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

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }

  return streamResponse(async (push) => {
    for await (const event of runAgentTurn({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      chatId: body.chatId,
      userMessage: body.message,
    })) {
      push(event);
    }
  });
}
