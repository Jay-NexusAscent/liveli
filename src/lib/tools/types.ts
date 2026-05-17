import { z } from "zod";

/**
 * Tool definition consumed by Anthropic's tool_use API. Each tool owns:
 *  - `name`: the identifier the model calls
 *  - `description`: prose the model uses to choose the tool
 *  - `inputSchema`: a Zod schema → also serialized to JSON Schema for the SDK
 *  - `handler`: server-side execution, scoped to a workspace
 *
 * Handlers take `unknown` and parse with the tool's own schema. Keeping the
 * interface non-generic avoids ZodObject variance pain when collecting tools
 * into a `ToolDefinition[]`.
 */

export interface AgentContext {
  orgId: string;
  userId: string;
  chatId: string;
}

export interface ToolResult {
  /** Structured payload returned to the model as tool_result content */
  content: unknown;
  /** Optional client-side render hint (e.g. for charts) */
  clientRender?:
    | { kind: "chart"; spec: unknown; title?: string }
    | { kind: "table"; rows: unknown[] };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown, ctx: AgentContext) => Promise<ToolResult>;
}
