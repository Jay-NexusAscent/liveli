import { zodToJsonSchema } from "zod-to-json-schema";
import { listTablesTool } from "./list-tables";
import { runSqlTool } from "./run-sql";
import { makeChartTool } from "./make-chart";
import { makeDashboardTool } from "./make-dashboard";
import type { AgentContext, ToolDefinition, ToolResult } from "./types";
import type { FunctionDeclaration } from "@google-cloud/vertexai";

export type { AgentContext, ToolDefinition, ToolResult };

export const tools: ToolDefinition[] = [
  listTablesTool,
  runSqlTool,
  makeChartTool,
  makeDashboardTool,
];

const byName = new Map(tools.map((t) => [t.name, t]));

/**
 * Convert JSON-Schema-7 (which zodToJsonSchema emits) into Gemini's
 * FunctionDeclaration parameter schema. The shape is JSON-Schema-like
 * but Gemini wants UPPERCASE type names ("OBJECT", "STRING") and a
 * limited subset of features (no $ref, no oneOf in most fields).
 *
 * Strategy: rename `type` fields recursively, drop the $schema/title
 * meta keys, leave the rest. Works for our tool specs because they're
 * shallow object-with-primitive-properties shapes.
 */
function jsonSchemaToGemini(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object") {
    return schema as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$schema" || k === "$ref" || k === "title" || k === "additionalProperties") continue;
    if (k === "type" && typeof v === "string") {
      out[k] = v.toUpperCase();
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "object" && item !== null ? jsonSchemaToGemini(item) : item
      );
    } else if (typeof v === "object" && v !== null) {
      out[k] = jsonSchemaToGemini(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Gemini tool spec — { name, description, parameters }. */
export function geminiFunctionDeclarations(): FunctionDeclaration[] {
  return tools.map((t) => {
    const schema = zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" });
    return {
      name: t.name,
      description: t.description,
      parameters: jsonSchemaToGemini(schema) as unknown as FunctionDeclaration["parameters"],
    };
  });
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
