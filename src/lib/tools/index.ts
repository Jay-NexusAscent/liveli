import { zodToJsonSchema } from "zod-to-json-schema";
import { listTablesTool } from "./list-tables";
import { runSqlTool } from "./run-sql";
import { makeChartTool } from "./make-chart";
import type { AgentContext, ToolDefinition, ToolResult } from "./types";

export type { AgentContext, ToolDefinition, ToolResult };

export const tools: ToolDefinition[] = [listTablesTool, runSqlTool, makeChartTool];

const byName = new Map(tools.map((t) => [t.name, t]));

/** Anthropic tool_use API expects { name, description, input_schema (JSON Schema) }. */
export function anthropicToolSpecs() {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }),
  }));
}

/** Dispatch a tool call from the model — handler is responsible for parsing its own input. */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: AgentContext
): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(rawInput, ctx);
}
