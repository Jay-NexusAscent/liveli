import { z } from "zod";
import {
  connectErrorEnvelope,
  provisionConnector,
} from "@/lib/connector-provisioning";
import { requireWorkspaceContext, UnauthorizedError } from "@/lib/clients";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * WooCommerce REST API auth = a consumer key/secret pair generated in WP
 * admin (WooCommerce → Settings → Advanced → REST API). Not OAuth. The
 * site URL is the storefront base (https://store.example.com).
 */
const Body = z.object({
  name: z.string().min(1).max(120).default("WooCommerce"),
  siteUrl: z.string().url().max(255),
  consumerKey: z.string().min(1).max(512),
  consumerSecret: z.string().min(1).max(512),
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
      type: "woocommerce",
      name: body.name,
      ctx,
      secretPayload: {
        site_url: body.siteUrl,
        consumer_key: body.consumerKey,
        consumer_secret: body.consumerSecret,
        ...(body.startDate ? { start_date: body.startDate } : {}),
      },
      // Surface the store URL so the card subtitle distinguishes multiple
      // WooCommerce stores on one workspace.
      firestoreFields: {
        siteUrl: body.siteUrl,
      },
      syncFrequency: body.syncFrequency,
    });

    return Response.json({
      ok: true,
      connectorId,
      message: "WooCommerce connection saved. Click Sync to start the first import.",
    });
  } catch (err) {
    const responseBody = connectErrorEnvelope("woocommerce", step.current, err, [
      body.consumerKey,
      body.consumerSecret,
    ]);
    console.error("[woocommerce/connect]", JSON.stringify(responseBody).slice(0, 2000));
    return Response.json(responseBody, { status: 500 });
  }
}
