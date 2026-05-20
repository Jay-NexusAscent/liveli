import type { MetadataRoute } from "next";

/**
 * Web App Manifest — describes how Liveli should behave when
 * installed as a PWA (Add to Home Screen on iOS, Install App on
 * Chrome). Next.js auto-serves this at `/manifest.webmanifest` and
 * adds the `<link rel="manifest">` tag.
 *
 * Dark theme/background by default — light-theme users still get
 * the same install experience; the install icon shows the indigo
 * ECG against the dark `#09090B` background.
 */

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Liveli — Talk to your data",
    short_name: "Liveli",
    description:
      "Connect your data sources, get an AI analyst that answers in plain English. No SQL, no dashboards, no data engineer.",
    start_url: "/",
    display: "standalone",
    background_color: "#09090B",
    theme_color: "#818CF8",
    orientation: "portrait-primary",
    categories: ["productivity", "business", "developer"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
