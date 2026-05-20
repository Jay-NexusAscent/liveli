import { ImageResponse } from "next/og";

/**
 * Auto-generated Open Graph image — rendered server-side by Next.js
 * via Satori at /opengraph-image. Surfaces on every social link
 * preview (Twitter/X, LinkedIn, Slack, Discord, iMessage).
 *
 * Design: dark background with the brand ECG line + wordmark on the
 * left, big indigo-accent tagline. 1200×630 is the canonical OG size
 * — every major platform respects this exact aspect ratio.
 *
 * Fonts: Space Grotesk (the site's heading font) is loaded from
 * Google Fonts at render time and passed to Satori so the type
 * matches the live site exactly. Without this, Satori falls back to
 * a default sans-serif with heavier strokes and visibly different
 * glyph proportions — looks off-brand against the rest of the
 * marketing surface.
 *
 * Note: Satori does NOT support Tailwind classes by default; styles
 * here are inline CSS. Keep the design simple — Satori's CSS subset
 * is narrow.
 */

export const alt = "Liveli — Talk to your data";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Fetch a Google Fonts binary at render time.
 *
 * Two-step fetch: the family/weight CSS endpoint returns CSS with
 * the actual font-file URL inside `src: url(...)`. Parse it out and
 * fetch the file.
 *
 * UA behaviour (verified empirically against the gstatic CDN):
 *  - Default fetch UA (no override)   → TTF response (preferred — Satori's most stable)
 *  - Mozilla browser UA              → WOFF response
 *  - Modern Chrome UA                → WOFF2 response (Satori handles, but TTF is safer)
 *
 * We deliberately DON'T set a User-Agent header — node's default
 * lands us on TTF. The regex accepts either truetype or woff so a
 * future Google Fonts change to its default-response format won't
 * break this silently.
 */
async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(
    / /g,
    "+"
  )}:wght@${weight}&display=swap`;
  const css = await fetch(cssUrl).then((r) => r.text());

  const match = css.match(/src:\s*url\((.+?)\)\s*format\('(truetype|woff)'\)/);
  if (!match) {
    throw new Error(
      `loadGoogleFont(${family}, ${weight}): no truetype/woff src in CSS response`
    );
  }
  const fontResponse = await fetch(match[1]);
  if (!fontResponse.ok) {
    throw new Error(
      `loadGoogleFont(${family}, ${weight}): font file fetch failed ${fontResponse.status}`
    );
  }
  return fontResponse.arrayBuffer();
}

export default async function OpenGraphImage() {
  // Load the two weights we use. Parallel fetch — Satori needs both
  // before rendering can begin.
  const [spaceGroteskMedium, spaceGroteskSemibold] = await Promise.all([
    loadGoogleFont("Space Grotesk", 500),
    loadGoogleFont("Space Grotesk", 600),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#09090B",
          backgroundImage:
            "radial-gradient(circle at 85% 15%, rgba(129, 140, 248, 0.18) 0%, transparent 55%)",
          padding: "72px 88px",
          fontFamily: "Space Grotesk",
        }}
      >
        {/* Top row — logo + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg
            width={56}
            height={45}
            viewBox="0 0 40 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M2 18 L8 18 L11 23 L16 5 L20 27 L24 18 L28 18 L31 14 L34 18 L38 18"
              stroke="#818CF8"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span
            style={{
              color: "#FAFAFA",
              fontSize: 40,
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            Liveli
          </span>
        </div>

        {/* Centre block — eyebrow + tagline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              color: "#A1A1AA",
              fontSize: 18,
              fontWeight: 500,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 9999,
                backgroundColor: "#818CF8",
              }}
            />
            AI Data Agent — Early Access
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              color: "#FAFAFA",
              fontSize: 104,
              fontWeight: 600,
              lineHeight: 1.02,
              letterSpacing: "-0.03em",
            }}
          >
            <span>Talk to your</span>
            <span style={{ color: "#818CF8" }}>data.</span>
          </div>
        </div>

        {/* Bottom row — URL + descriptor */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "#52525B",
            fontSize: 22,
            fontWeight: 500,
          }}
        >
          <span>liveli.co.uk</span>
          <span>Fully managed agentic data platform</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "Space Grotesk",
          data: spaceGroteskMedium,
          style: "normal",
          weight: 500,
        },
        {
          name: "Space Grotesk",
          data: spaceGroteskSemibold,
          style: "normal",
          weight: 600,
        },
      ],
    }
  );
}
