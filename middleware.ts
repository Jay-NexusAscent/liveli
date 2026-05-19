import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Host-based subdomain routing.
 *
 * liveli.co.uk             → marketing (public)
 * www.liveli.co.uk         → marketing (public, redirects to apex via Vercel)
 * app.liveli.co.uk         → product   (auth-walled, route group (app))
 * localhost (any port)     → both, distinguished by path
 *
 * Behaviour:
 *  - App host root ("/") redirects to "/chat".
 *  - Marketing host + app route → 308 redirect to the app subdomain.
 *    Handles the post-sign-in flow: user clicks sign-in on liveli.co.uk,
 *    Clerk's fallback URL is "/chat", we bounce them to
 *    app.liveli.co.uk/chat where the app routes actually render.
 *  - On localhost (dev), no cross-subdomain redirect happens — devs
 *    work entirely from http://localhost:3000 by default.
 */

const APP_HOST_SUFFIXES = ["app.liveli.co.uk", "app.localhost"];
const MARKETING_HOSTS = new Set(["liveli.co.uk", "www.liveli.co.uk"]);
const APP_HOST_PRODUCTION = "app.liveli.co.uk";

const isAppRoute = createRouteMatcher([
  "/chat(.*)",
  "/connections(.*)",
  "/dashboards(.*)",
  "/settings(.*)",
]);

const isPublicAuthRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/onboarding(.*)",
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

  // Production-only: app routes hit on the marketing host bounce to the
  // app subdomain. This is what makes Clerk's "/chat" sign-in fallback
  // land on app.liveli.co.uk instead of leaving the user on
  // liveli.co.uk/chat (which would technically render but break the
  // mental model of marketing vs app).
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
