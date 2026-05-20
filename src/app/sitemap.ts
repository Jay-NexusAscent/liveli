import type { MetadataRoute } from "next";

/**
 * Sitemap for crawlers. Lists only the marketing surface — the
 * authenticated app routes are noindexed via the (app) layout's
 * metadata block.
 *
 * Anchor fragments (`#features`, `#how-it-works`, `#pricing`) are
 * NOT separate entries — Google ignores anchor-only URLs in
 * sitemaps and uses them only as in-page jump links anyway. Listing
 * `/` is enough; the crawler will pull the rest from the page.
 */

const MARKETING_URL =
  process.env.NEXT_PUBLIC_MARKETING_URL ?? "https://liveli.co.uk";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: `${MARKETING_URL}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
