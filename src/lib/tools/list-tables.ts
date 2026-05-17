import { z } from "zod";
import { listWorkspaceTables } from "@/lib/bigquery";
import type { ToolDefinition } from "./types";

const Input = z.object({});

export const listTablesTool: ToolDefinition = {
  name: "list_tables",
  description:
    "List every table available in the user's workspace warehouse, including row counts and column types. Call this first when the user asks an open-ended question so you know what data exists.",
  inputSchema: Input,
  handler: async (_raw, ctx) => {
    const tables = await listWorkspaceTables(ctx.orgId);
    return { content: { tables } };
  },
};
