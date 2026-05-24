import { z } from "zod";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { introspectPostgresSchema } from "@/lib/postgres-introspection";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  name: z.string().min(1).max(120).default("Postgres"),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  ssl: z.boolean().default(true),
  schemas: z.string().optional().describe("Comma-separated schemas to sync (default: public)"),
  syncFrequency: z.enum(["5m", "15m", "30m", "1h", "6h", "12h", "24h"]).default("1h"),
});

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireWorkspaceContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  const step = { current: "init" };
  try {
    // Introspect the source database BEFORE we touch any of our own
    // state. This doubles as a creds liveness check — if we can't
    // connect or read information_schema, the wizard fails fast with
    // a useful error rather than committing a connector that will
    // silently break on first sync. No persistent resources have been
    // created at this point, so no cleanup is needed on failure here.
    //
    // Output drives per-stream incremental-sync config: each table
    // gets INCREMENTAL with an `updated_at`-family key when one
    // exists, INCREMENTAL with the integer PK when that's all there
    // is, FULL_TABLE for non-integer PKs, or EXCLUDED for tables
    // without a single-column PK (LIVELI-111 — incompatible with the
    // loader's upsert mode). Persisted to the Firestore connector doc
    // and re-injected as a meltano.yml metadata block at sync time.
    step.current = "introspect postgres schema";
    const schemaList = (body.schemas ?? "public")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let replicationConfig;
    try {
      replicationConfig = await introspectPostgresSchema({
        host: body.host,
        port: body.port,
        database: body.database,
        user: body.user,
        password: body.password,
        ssl: body.ssl,
        schemas: schemaList,
      });
    } catch (introspectErr) {
      // Customer-facing: most introspection failures are connection or
      // auth problems they need to fix in their wizard input. Return
      // 400 with the underlying error visible so they can act on it.
      const msg =
        introspectErr instanceof Error
          ? introspectErr.message
          : String(introspectErr);
      return Response.json(
        {
          error: "Couldn't connect to the Postgres source",
          errorMessage: msg,
        },
        { status: 400 }
      );
    }

    // Empty result means the schema filter matched zero tables —
    // almost always a user-input mistake (wrong schema name, typo).
    // Surface this before they save a connector that would sync nothing.
    if (replicationConfig.detected.length === 0) {
      return Response.json(
        {
          error: `No tables found in schema(s): ${schemaList.join(", ")}. Check that the schema name is correct and your user has SELECT privileges.`,
        },
        { status: 400 }
      );
    }

    // Provision the connector — BQ dataset + Secret Manager secret +
    // Firestore doc + Cloud Scheduler job. Compensating cleanup on
    // partial failure happens inside provisionConnector itself
    // (LIVELI-79 / LIVELI-119).
    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "postgres",
      name: body.name,
      ctx,
      secretPayload: {
        host: body.host,
        port: String(body.port),
        database: body.database,
        user: body.user,
        password: body.password,
        ssl: body.ssl ? "true" : "false",
        schemas: body.schemas ?? "public",
      },
      firestoreFields: {
        // Connection metadata shown in the edit modal. Non-sensitive
        // (the password lives only in Secret Manager).
        host: body.host,
        port: body.port,
        database: body.database,
        user: body.user,
        ssl: body.ssl,
        schemas: body.schemas ?? "public",
        // Replication config from connect-time introspection: `streams`
        // is the Meltano-format per-stream metadata overrides injected
        // at sync time, `excludedStreams` is the no-PK tables that the
        // tap will skip entirely, `detected` is the human-readable
        // summary shown in the edit modal.
        replicationConfig,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Connector saved. Click Sync to start the first import.",
    });
  } catch (err) {
    // provisionConnector has already done its compensating cleanup if
    // it threw — we just need to build the customer-facing envelope.
    // Pass body.password as a sensitive value so it gets redacted out
    // of any error strings the SDK may have stringified it into.
    const responseBody = connectErrorEnvelope(
      "postgres",
      step.current,
      err,
      [body.password]
    );
    console.error("[postgres/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
