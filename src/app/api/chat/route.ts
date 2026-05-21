import { z } from "zod";
import { runAgentTurn } from "@/lib/agent";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import { streamResponse } from "@/lib/streaming";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Edit-context payload sent by the client when the user is editing an
 * existing chart or dashboard via chat. The agent route forwards this
 * to runAgentTurn which injects the context into the system prompt so
 * the model knows to call update_chart / update_dashboard with the
 * provided id, instead of make_chart / make_dashboard which would
 * create a new copy.
 *
 * Loose validation by design — the spec object is whatever the chart
 * had when the user clicked Edit; we don't re-validate against the
 * full ECharts shape here because the model handles malformed input
 * via the defensive normalisation in update-chart.ts / make-chart.ts.
 */
const EditContext = z.object({
  kind: z.enum(["chart", "dashboard"]),
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  spec: z.unknown().optional(),
  description: z.string().nullable().optional(),
  charts: z
    .array(
      z.object({
        order: z.number().optional(),
        title: z.string(),
        spec: z.unknown(),
      })
    )
    .optional(),
});

const Body = z.object({
  message: z.string().min(1).max(4000),
  chatId: z.string().optional(),
  editContext: EditContext.optional(),
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
      editContext: body.editContext,
    })) {
      push(event);
    }
  });
}
