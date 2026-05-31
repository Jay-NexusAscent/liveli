import { zodToJsonSchema } from "zod-to-json-schema";
import { listTablesTool } from "./list-tables";
import { describeTableTool } from "./describe-table";
import { runSqlTool } from "./run-sql";
import { makeChartTool } from "./make-chart";
import { makeDashboardTool } from "./make-dashboard";
import { updateChartTool } from "./update-chart";
import { updateDashboardTool } from "./update-dashboard";
import { saveInsightTool } from "./save-insight";
import { proposeInsightsTool } from "./propose-insights";
import { forecastTool } from "./forecast";
import { detectAnomaliesTool } from "./detect-anomalies";
import { classifyTool } from "./classify";
import { segmentTool } from "./segment";
import { recommendTool } from "./recommend";
import type { AgentContext, ToolDefinition, ToolResult } from "./types";
import type { FunctionDeclaration } from "@google-cloud/vertexai";

export type { AgentContext, ToolDefinition, ToolResult };

export const tools: ToolDefinition[] = [
  listTablesTool,
  describeTableTool,
  runSqlTool,
  makeChartTool,
  makeDashboardTool,
  updateChartTool,
  updateDashboardTool,
  saveInsightTool,
  proposeInsightsTool,
  forecastTool,
  detectAnomaliesTool,
  classifyTool,
  segmentTool,
  recommendTool,
];

const byName = new Map(tools.map((t) => [t.name, t]));

/**
 * Convert JSON-Schema-7 (zodToJsonSchema output) into Gemini's
 * FunctionDeclaration parameter schema. Gemini wants UPPERCASE type
 * names ("OBJECT", "STRING") and a STRICT subset of features:
 *
 * Rejected / not supported by Gemini's Schema proto:
 *   - $schema, $ref, additionalProperties (JSON-Schema metadata)
 *   - title (JSON-Schema meta; Gemini's title is different)
 *   - type: [a, b]  → Gemini wants a single Type enum value
 *
 * Strategy:
 *   - Drop metadata keys.
 *   - Uppercase `type` strings.
 *   - For `type: [a, b]`, pick the first non-"null" entry and warn.
 *     (Source schemas should avoid this — see make-chart.ts comment.)
 *   - Recurse into nested objects and arrays.
 */
function jsonSchemaToGemini(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object") {
    return schema as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$schema" || k === "$ref" || k === "title" || k === "additionalProperties") continue;
    if (k === "type") {
      if (typeof v === "string") {
        out[k] = v.toUpperCase();
      } else if (Array.isArray(v)) {
        const picked = (v as unknown[]).find(
          (t) => typeof t === "string" && t !== "null"
        );
        if (typeof picked === "string") {
          out[k] = picked.toUpperCase();
        }
        console.warn(
          `[geminiFunctionDeclarations] union type ${JSON.stringify(v)} collapsed to '${out[k] ?? "<dropped>"}' — Gemini Schema requires a single Type. Avoid z.union() in tool input schemas.`
        );
      }
      continue;
    }
    if (k === "properties") {
      // CRITICAL: `properties` is a map<string, Schema> in Gemini's proto.
      // The keys are arbitrary property names chosen by the schema author
      // — they CAN be "type", "enum", "required" etc. We must NOT pass
      // those keys through the Schema-keyword logic above (otherwise a
      // property literally named "type" gets swallowed by the type-handler
      // and dropped from the output, leaving `required: ["type"]` referring
      // to a missing property). Walk values only; each value is itself a
      // Schema processed by a fresh jsonSchemaToGemini call.
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const propsOut: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(v as Record<string, unknown>)) {
          propsOut[propName] =
            typeof propSchema === "object" && propSchema !== null
              ? jsonSchemaToGemini(propSchema)
              : propSchema;
        }
        out[k] = propsOut;
      }
      continue;
    }
    if (Array.isArray(v)) {
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

/**
 * Gemini tool spec — { name, description, parameters }.
 *
 * `$refStrategy: "none"` forces zodToJsonSchema to fully inline every
 * subschema. The default ("root") dedupes by emitting $ref pointers
 * (e.g. yAxis → "$ref":"#/properties/.../xAxis" when both reuse the
 * same Zod schema), and Gemini's Schema proto can't resolve $ref. The
 * resulting schema is slightly larger but valid.
 */
export function geminiFunctionDeclarations(): FunctionDeclaration[] {
  return tools.map((t) => {
    const schema = zodToJsonSchema(t.inputSchema, {
      target: "jsonSchema7",
      $refStrategy: "none",
    });
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
  if (!tool) throw new Error(unknownToolMessage(name));
  return tool.handler(rawInput, ctx);
}

/**
 * Build a self-correcting error for a tool name the model invented. The
 * observed failure was a hallucinated `MakeDashboardFilters` tool —
 * the model reached for a dedicated "add filters" tool that doesn't
 * exist, because filters are an ARGUMENT of make_dashboard, not their
 * own tool. A bare "Unknown tool" gives the model nothing to recover
 * with; this points it at the real call. We special-case the
 * dashboard-filter confusion and otherwise list the valid tool names.
 */
function unknownToolMessage(name: string): string {
  const valid = tools.map((t) => t.name).join(", ");
  if (/dashboard/i.test(name) && /filter/i.test(name)) {
    return (
      `Unknown tool: ${name}. There is no separate filter tool — dashboard filters are the ` +
      `\`filters[]\` argument of make_dashboard (and update_dashboard). Declare the filters there, ` +
      `then reference them in each chart's sourceSql via {{filter:<id>.<field>}}. Valid tools: ${valid}.`
    );
  }
  return `Unknown tool: ${name}. Valid tools: ${valid}.`;
}
