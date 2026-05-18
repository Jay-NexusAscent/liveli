import { z } from "zod";
import { listWorkspaceTables } from "@/lib/bigquery";
import { connectorsIn, dbReady } from "@/lib/firestore";
import type { ToolDefinition } from "./types";

const Input = z.object({});

/**
 * Returns every table the user's connectors have synced, grouped by
 * connector (the agent gets a `dataset` per connector + the table name
 * inside it). The agent SHOULD use the fully-qualified `dataset.table`
 * form in any SQL it then writes — there is no shared default dataset
 * in the new model.
 */
export const listTablesTool: ToolDefinition = {
  name: "list_tables",
  description:
    "List every table available across all of the user's connected data sources, including row counts and column types. Each connector has its own BigQuery dataset; the response groups tables by connector and provides the dataset name. Always call this first when the user asks an open-ended question. When you then write SQL, fully qualify table names as `dataset.table`.",
  inputSchema: Input,
  handler: async (_raw, ctx) => {
    await dbReady();
    const snap = await connectorsIn(ctx.clientId, ctx.workspaceId).get();
    const connectorRefs = snap.docs.map((d) => {
      const data = d.data() as { name?: string; type?: string };
      return { id: d.id, name: data.name, type: data.type };
    });

    const tables = await listWorkspaceTables(
      ctx.clientId,
      ctx.workspaceId,
      connectorRefs
    );

    return { content: { tables } };
  },
};
