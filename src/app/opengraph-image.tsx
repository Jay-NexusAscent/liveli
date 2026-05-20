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
 * Note: Satori does NOT support Tailwind classes by default; styles
 * here are inline CSS. Keep the design simple — Satori's CSS subset
 * is narrow.
 */

export const alt = "Liveli — Talk to your data";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
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
          fontFamily: "system-ui, -apple-system, sans-serif",
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
          }}
        >
          <span>liveli.co.uk</span>
          <span>Fully managed agentic data platform</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
