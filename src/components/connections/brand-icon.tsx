// ============================================
// Liveli — Brand icon for connector source cards
// ============================================
//
// Two-tier rendering for the catalogue cards on /connections:
//
//   1. Try a simple-icons brand icon for the source's `name`. We
//      maintain an allowlist BRANDS map below so a typo or missing
//      icon falls through cleanly rather than throwing at import.
//   2. If no brand match, the card render falls back to a
//      category icon (one per SourceCategory).
//   3. If neither matches (shouldn't happen — every category has an
//      icon), DatabaseIcon is the last-resort fallback in the page.
//
// Why allowlist rather than dynamic import: simple-icons exports per
// brand as named exports, and many big-enterprise brands have been
// pulled from the library over trademark concerns (Salesforce,
// Oracle, Adobe, Klaviyo, Amplitude, Chargebee, …). Hard-coding the
// available ones is safer than runtime probing.

import type { SimpleIcon } from "simple-icons";
import {
  siAsana,
  siBigcommerce,
  siDuckdb,
  siGithub,
  siGoogleads,
  siGoogleanalytics,
  siGooglebigquery,
  siGooglesheets,
  siHubspot,
  siIntercom,
  siJira,
  siLinear,
  siMailchimp,
  siMariadb,
  siMeta,
  siMixpanel,
  siMongodb,
  siMysql,
  siNotion,
  siPaypal,
  siPostgresql,
  siQuickbooks,
  siSage,
  siShopify,
  siSnowflake,
  siSquare,
  siStripe,
  siTiktok,
  siWoocommerce,
  siXero,
  siZendesk,
} from "simple-icons";

// Brands that aren't in simple-icons (trademark pulls or never added):
// Slack, LinkedIn, ActiveCampaign, Salesforce, Oracle, Adobe, Amazon,
// Microsoft SQL Server, Amazon Redshift, Klaviyo, Pipedrive, Close,
// Recurly, Chargebee, Amplitude, Segment, Microsoft Ads, Freshdesk,
// Adobe Commerce. These fall through to the category icon in the card
// render — see CATEGORY_ICON in connections/page.tsx.

/**
 * Map from PopularSource.name → simple-icons brand definition.
 *
 * Keys must match the catalogue's `name` field exactly. Brands not
 * listed here fall through to the category icon — see the screenshot
 * card render in src/app/(app)/connections/page.tsx. Add an entry
 * whenever you (a) ship a new connector and (b) the brand has a
 * simple-icons entry.
 */
const BRANDS: Record<string, SimpleIcon | undefined> = {
  // Databases (7 of 10 covered — Oracle, MSSQL, Redshift trademark-pulled)
  "PostgreSQL": siPostgresql,
  "MySQL": siMysql,
  "BigQuery": siGooglebigquery,
  "MongoDB": siMongodb,
  "Snowflake": siSnowflake,
  "MariaDB": siMariadb,
  "DuckDB": siDuckdb,

  // Payments (3 of 5 — Chargebee + Recurly missing)
  "Stripe": siStripe,
  "PayPal": siPaypal,
  "Square": siSquare,

  // E-commerce (3 of 5 — Adobe Commerce + Amazon Seller missing)
  "Shopify": siShopify,
  "WooCommerce": siWoocommerce,
  "BigCommerce": siBigcommerce,

  // CRM (2 of 5 — Salesforce + Pipedrive + Close missing)
  "HubSpot": siHubspot,
  "Zendesk Sell": siZendesk,

  // Marketing (4 of 8 — LinkedIn / Microsoft Ads / Klaviyo /
  // ActiveCampaign not in simple-icons)
  "Google Ads": siGoogleads,
  "Meta Ads": siMeta,
  "TikTok Ads": siTiktok,
  "Mailchimp": siMailchimp,

  // Analytics (2 of 4 — Amplitude + Segment missing)
  "Google Analytics 4": siGoogleanalytics,
  "Mixpanel": siMixpanel,

  // Project Management (4 of 4 — full coverage)
  "Jira": siJira,
  "Asana": siAsana,
  "Linear": siLinear,
  "Notion": siNotion,

  // Support (2 of 3 — Freshdesk missing)
  "Intercom": siIntercom,
  "Zendesk Support": siZendesk,

  // Finance (3 of 3 — full coverage)
  "QuickBooks": siQuickbooks,
  "Xero": siXero,
  "Sage Intacct": siSage,

  // Productivity (2 of 3 — Slack not in simple-icons)
  "GitHub": siGithub,
  "Google Sheets": siGooglesheets,
};

interface BrandIconProps {
  /** PopularSource.name to look up. */
  name: string;
  /** Pixel size of the icon (default 20, matches DatabaseIcon). */
  size?: number;
}

/**
 * Render a brand-coloured SVG for the named source, or `null` if no
 * simple-icons entry is registered. Callers should check
 * `hasBrandIcon(name)` first (or just render this and use null-fallback
 * with || in JSX).
 */
export function BrandIcon({ name, size = 20 }: BrandIconProps) {
  const icon = BRANDS[name];
  if (!icon) return null;
  return (
    <svg
      role="img"
      aria-label={icon.title}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={`#${icon.hex}`}
    >
      <path d={icon.path} />
    </svg>
  );
}

/** True iff `name` has a brand-icon entry in the allowlist. */
export function hasBrandIcon(name: string): boolean {
  return Boolean(BRANDS[name]);
}
