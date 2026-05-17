import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Host-based subdomain routing.
 *
 * liveli.co.uk             → marketing (public)
 * app.liveli.co.uk         → product   (auth-walled, route group (app))
 * localhost (any port)     → both, distinguished by path
 *
 * The middleware rewrites incoming app.* requests so that "/" lands on the
 * authenticated experience instead of the marketing landing page.
 */

const APP_HOST_SUFFIXES = ["app.liveli.co.uk", "app.localhost"];

const isAppRoute = createRouteMatcher([
  "/chat(.*)",
  "/connections(.*)",
  "/dashboards(.*)",
  "/onboarding(.*)",
]);

const isPublicAuthRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  const host = req.headers.get("host") ?? "";
  const isAppHost = APP_HOST_SUFFIXES.some((suffix) => host.startsWith(suffix));

  // Rewrite the app subdomain so "/" lands on /chat.
  if (isAppHost && req.nextUrl.pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/chat";
    return NextResponse.redirect(url);
  }

  // Protect product routes.
  if (isAppRoute(req) && !isPublicAuthRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/", "/(api|trpc)(.*)"],
};
