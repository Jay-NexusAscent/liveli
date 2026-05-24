import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const Body = z.object({
  name: z.string().min(1).max(120).default("GitHub"),
  accessToken: z
    .string()
    .min(1)
    .max(512)
    .regex(
      /^(ghp_|github_pat_)/,
      "GitHub PATs start with ghp_ (classic) or github_pat_ (fine-grained)"
    ),
  repositories: z
    .array(z.string().regex(REPO_PATTERN, "Repository must be in owner/repo format"))
    .min(1, "At least one repository is required")
    .max(50, "Limit 50 repositories per connector — split into multiple connectors for larger orgs"),
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
    step.current = "provisionConnector";
    const { connectorId } = await provisionConnector({
      type: "github",
      name: body.name,
      ctx,
      secretPayload: {
        auth_token: body.accessToken,
        // tap-github expects `repositories` as a JSON array — store it
        // serialised so the env-var builder can pass it through verbatim.
        repositories: JSON.stringify(body.repositories),
      },
      firestoreFields: {
        // Non-sensitive display: number + first few repo names for the
        // edit modal so customers can see what's being synced without
        // opening the secret.
        repositoryCount: body.repositories.length,
        repositoriesPreview: body.repositories.slice(0, 5),
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "GitHub connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("github", step.current, err, [
      body.accessToken,
    ]);
    console.error("[github/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
