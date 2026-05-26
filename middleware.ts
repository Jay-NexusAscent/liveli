import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Host-based subdomain routing.
 *
 * Primary brand domain (post-2026-05 migration to .ai):
 *   liveli.ai            → marketing (public)
 *   www.liveli.ai        → marketing (308 → liveli.ai via Vercel)
 *   app.liveli.ai        → product (auth-walled, route group (app))
 *
 * Legacy .co.uk hosts (kept for back-compat — Vercel redirects them
 * at the edge to the .ai equivalents, so this middleware rarely sees
 * them today, but the sets are kept populated for defence in depth):
 *   liveli.co.uk         → 308 (Vercel) → liveli.ai
 *   www.liveli.co.uk     → 308 (Vercel) → liveli.ai
 *   app.liveli.co.uk     → 308 (Vercel) → app.liveli.ai
 *
 * Localhost (dev):
 *   localhost:3000       → both, distinguished by path (no cross-
 *                          subdomain redirect)
 *
 * Behaviour:
 *  - App host root ("/") redirects to "/chat".
 *  - Marketing host + app route → 308 redirect to app.liveli.ai.
 *    Handles the post-sign-in flow: user clicks sign-in on liveli.ai,
 *    Clerk's fallback URL is "/chat", we bounce them to
 *    app.liveli.ai/chat where the app routes actually render.
 *  - On localhost, no cross-subdomain redirect — devs work entirely
 *    from http://localhost:3000.
 */

const APP_HOST_SUFFIXES = [
  "app.liveli.ai",
  "app.liveli.co.uk", // legacy — Vercel 308s to app.liveli.ai
  "app.localhost",
];
const MARKETING_HOSTS = new Set([
  "liveli.ai",
  "www.liveli.ai",
  "liveli.co.uk", // legacy — Vercel 308s to liveli.ai
  "www.liveli.co.uk",
]);

/**
 * Production app host — where marketing→app redirects land.
 *
 * Post-migration this is unconditionally `app.liveli.ai`. We could
 * route .co.uk visitors to `app.liveli.co.uk` instead and let Vercel's
 * edge 308 handle the second hop, but a one-hop redirect (apex →
 * direct to the right app subdomain) is cleaner for the customer than
 * a two-hop chain (apex → legacy app → new app).
 */
const APP_HOST_PRODUCTION = "app.liveli.ai";

const isAppRoute = createRouteMatcher([
  "/chat(.*)",
  "/connections(.*)",
  "/dashboards(.*)",
  "/settings(.*)",
]);

const isPublicAuthRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  const host = req.headers.get("host") ?? "";
  const isAppHost = APP_HOST_SUFFIXES.some((suffix) => host.startsWith(suffix));
  const isMarketingHost = MARKETING_HOSTS.has(host);

  // App-host root → /chat.
  if (isAppHost && req.nextUrl.pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/chat";
    return NextResponse.redirect(url);
  }

  // Marketing host + app route → 308 to the app subdomain. Without
  // this redirect, e.g. liveli.ai/connections would render the app
  // directly on the marketing apex — Clerk session works there
  // (cookie domain is .liveli.ai) but it breaks the mental model AND
  // trips downstream guards (the OAuth route's origin allowlist
  // checks for app.liveli.ai, not the marketing apex — see
  // src/app/api/auth/oauth/[provider]/start/route.ts).
  if (isMarketingHost && isAppRoute(req)) {
    const url = req.nextUrl.clone();
    url.host = APP_HOST_PRODUCTION;
    url.protocol = "https:";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }

  // Protect product routes (runs on the app host).
  if (isAppRoute(req) && !isPublicAuthRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/", "/(api|trpc)(.*)"],
};
