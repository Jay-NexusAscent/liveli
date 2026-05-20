import type { MetadataRoute } from "next";

/**
 * robots.txt — crawler instructions for the marketing host.
 *
 * The marketing surface is fully public. The authenticated app
 * (app.liveli.co.uk/*) is on a different subdomain so its
 * robots.txt is also served from here (same Next.js app), and we
 * disallow the API namespace + auth pages from being crawled.
 *
 * Auth pages (/sign-in, /sign-up) are intentionally NOT in
 * disallow — Clerk's pages should be reachable via a search for
 * "Liveli sign in" but we don't list them in the sitemap because
 * they're conversion endpoints, not destination pages.
 */

const MARKETING_URL =
  process.env.NEXT_PUBLIC_MARKETING_URL ?? "https://liveli.co.uk";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/api/",
          "/_next/",
          "/chat",
          "/connections",
          "/dashboards",
          "/insights",
          "/settings",
        ],
      },
    ],
    sitemap: `${MARKETING_URL}/sitemap.xml`,
    host: MARKETING_URL,
  };
}
