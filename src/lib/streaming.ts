/**
 * SSE event types streamed from /api/chat to the client.
 * Client splits on "\n\n", JSON-parses each event, dispatches by `type`.
 */

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown; error?: string }
  | { type: "chart"; id: string; title: string; spec: unknown }
  | { type: "table"; id: string; rows: unknown[] }
  | { type: "dashboard"; id: string; dashboardId: string; title: string }
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
        push({ type: "error", error: message });
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
