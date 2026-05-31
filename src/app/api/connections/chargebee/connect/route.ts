import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Chargebee auth = API key + the site name (the `<site>` in
 * <site>.chargebee.com). product_catalog MUST match the account's plan
 * version ("1.0" vs "2.0") or streams break — default "2.0".
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("Chargebee"),
  site: z
    .string()
    .min(1)
    .max(63)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Site must be the slug from yoursite.chargebee.com (lowercase letters, digits, hyphens)"
    ),
  apiKey: z.string().min(1).max(512),
  productCatalog: z.enum(["1.0", "2.0"]).default("2.0"),
  startDate: z.string().datetime().optional(),
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
      type: "chargebee",
      name: body.name,
      ctx,
      secretPayload: {
        api_key: body.apiKey,
        site: body.site,
        product_catalog: body.productCatalog,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      firestoreFields: {
        site: body.site,
        productCatalog: body.productCatalog,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "Chargebee connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("chargebee", step.current, err, [
      body.apiKey,
    ]);
    console.error("[chargebee/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
