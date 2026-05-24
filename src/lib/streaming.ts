/**
 * SSE event types streamed from /api/chat to the client.
 * Client splits on "\n\n", JSON-parses each event, dispatches by `type`.
 */

/**
 * One proposed insight from `propose_insights`. Shape mirrors
 * save_insight input so the UI can POST it straight through to
 * /api/insights on accept without re-mapping fields.
 *
 * NOTE: proposals are NOT persisted by the agent — they live in the
 * chat message until the user clicks Save. If the chat is reloaded
 * before acceptance, proposals are lost; this is intentional (avoids
 * a "proposal limbo" state in Firestore).
 */
export interface InsightProposal {
  title: string;
  description: string;
  category: "Sales" | "Customer" | "Operational" | "Growth";
  sourceSql: string;
  sourceConnector?: string;
  ruleType: "change_pct_above" | "change_pct_below" | "value_above" | "value_below";
  threshold: number;
  prefill: string;
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown; error?: string }
  | { type: "chart"; id: string; title: string; spec: unknown }
  | { type: "table"; id: string; rows: unknown[] }
  | {
      type: "dashboard";
      id: string;
      dashboardId: string;
      title: string;
      description?: string;
      // colSpan threads through from make_dashboard / update_dashboard
      // clientRender so the inline chat preview can render with the
      // same Small/Medium/Large tile widths as /dashboards.
      charts: Array<{
        order: number;
        title: string;
        spec: unknown;
        colSpan?: "small" | "medium" | "large";
      }>;
    }
  | {
      // propose_insights tool output. Renders as an inline card list in
      // chat with a Save button per card; user picks which to persist.
      // Nothing is in Firestore at this point — the agent emitted the
      // proposals but stopped short of save_insight.
      type: "insight-proposals";
      id: string;
      proposals: InsightProposal[];
    }
  | { type: "message_start"; chatId: string; messageId: string }
  | { type: "message_stop" }
  | { type: "error"; error: string }
  | { type: "done" };

/** Serialise one event as an SSE-style "data:" line. */
export function encodeEvent(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build a streaming Response with the right headers for Server-Sent Events.
 * `producer` is an async iterator-like callback that pushes events.
 */
export function streamResponse(
  producer: (
    push: (event: ChatStreamEvent) => void
  ) => Promise<void>
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (event: ChatStreamEvent) => {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      };
      try {
        await producer(push);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : typeof err;
        // Surface the full error to Vercel runtime logs — without this,
        // a Vertex / Firestore / BigQuery failure inside the stream
        // shows up as a silent "thinking… forever" on the client and
        // there's no way to diagnose it after the fact.
        // Walk the error properties so non-Error throwables (e.g.
        // GoogleAuthError wrappers) surface their actual cause too.
        const props: Record<string, unknown> = {};
        if (err && typeof err === "object") {
          for (const key of Object.getOwnPropertyNames(err)) {
            try {
              const v = (err as Record<string, unknown>)[key];
              if (typeof v !== "function") props[key] = v;
            } catch {
              /* unreadable */
            }
          }
        }
        console.error("[chat-stream] producer threw", {
          message,
          name,
          stack: err instanceof Error ? err.stack : undefined,
          props,
        });
        // Send a richer error event to the client so the UI shows
        // ${name}: ${message}, not just message — helps distinguish
        // a SyntaxError (auth/HTML response) from a SafetyError, etc.
        push({ type: "error", error: `${name}: ${message}` });
      } finally {
        push({ type: "done" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering if any
    },
  });
}
