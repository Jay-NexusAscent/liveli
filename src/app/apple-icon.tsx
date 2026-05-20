import { ImageResponse } from "next/og";

/**
 * Apple touch icon — 180×180 PNG that iOS uses for home-screen
 * installs and Safari tab favicons on iPadOS.
 *
 * Apple specifically wants PNG (not SVG) at this size, so we
 * generate via ImageResponse rather than serving a static file —
 * keeps everything code-only with no PNG asset to manage.
 *
 * Background is the dark brand `#09090B` because iOS draws the
 * apple-icon on a rounded-rectangle home-screen tile that wouldn't
 * pick up the user's wallpaper through transparency.
 */

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#09090B",
        }}
      >
        <svg
          width={140}
          height={112}
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
      </div>
    ),
    { ...size }
  );
}
