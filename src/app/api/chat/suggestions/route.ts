import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import {
  getPromptSuggestions,
  DEFAULT_PROMPT_SUGGESTIONS,
} from "@/lib/chat/prompt-suggestions";

/**
 * GET /api/chat/suggestions
 *
 * Data-aware example questions for the empty chat screen, tailored to the
 * current workspace's connected tables (Gemini Flash, cached per schema).
 * Always 200s with a usable list — falls back to generic defaults rather
 * than failing the empty-state render.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ suggestions: DEFAULT_PROMPT_SUGGESTIONS }, { status: 401 });
    }
    throw err;
  }

  const suggestions = await getPromptSuggestions(ctx.clientId, ctx.workspaceId);
  return Response.json({ suggestions });
}
