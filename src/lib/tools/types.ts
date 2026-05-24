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
  /** Clerk Org ID (= our Client ID). All tenant-scoped reads must use this. */
  clientId: string;
  /** The user's currently-selected workspace within the Client. */
  workspaceId: string;
  userId: string;
  chatId: string;
  /**
   * @deprecated alias for clientId — kept while old callsites are migrated.
   * Remove after all references are updated.
   */
  orgId: string;
}

export interface ToolResult {
  /** Structured payload returned to the model as tool_result content */
  content: unknown;
  /** Optional client-side render hint (e.g. for charts) */
  clientRender?:
    | { kind: "chart"; spec: unknown; title?: string }
    | { kind: "table"; rows: unknown[] }
    | {
        kind: "dashboard";
        dashboardId: string;
        title: string;
        description?: string;
        charts: Array<{ order: number; title: string; spec: unknown }>;
      }
    | {
        // propose_insights — list of proposals rendered inline in chat
        // as cards with per-card Save buttons. The proposals are NOT
        // yet persisted; user clicks Save to POST each one to
        // /api/insights. See InsightProposal shape in @/lib/streaming.
        kind: "insight-proposals";
        proposals: import("@/lib/streaming").InsightProposal[];
      };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown, ctx: AgentContext) => Promise<ToolResult>;
}
