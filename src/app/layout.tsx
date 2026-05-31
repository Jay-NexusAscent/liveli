import type { Metadata, Viewport } from "next";
import { Space_Grotesk, DM_Sans, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"] });
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Centralised so root and OG/Twitter blocks stay in lockstep.
const SITE_TITLE = "Liveli — Talk to your data";
const SITE_DESCRIPTION =
  "Liveli connects your data sources, runs the warehouse for you, and gives your team an AI analyst that answers questions and builds dashboards in plain English.";
const SITE_TAGLINE = "Connect your data, ask the AI, ship the dashboard.";

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: "%s · Liveli",
  },
  description: SITE_DESCRIPTION,
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_MARKETING_URL ?? "https://liveli.co.uk"
  ),
  applicationName: "Liveli",
  authors: [{ name: "Liveli Ltd" }],
  creator: "Liveli Ltd",
  publisher: "Liveli Ltd",
  keywords: [
    "AI data analyst",
    "natural language data analytics",
    "managed data warehouse",
    "data agent",
    "AI analytics platform",
    "agentic data platform",
  ],
  // OG image is auto-discovered from src/app/opengraph-image.tsx — no
  // need to specify openGraph.images here.
  openGraph: {
    title: SITE_TITLE,
    description: SITE_TAGLINE,
    type: "website",
    locale: "en_GB",
    siteName: "Liveli",
    url: "/",
  },
  // Twitter Card — falls back to opengraph-image when twitter-image
  // isn't present, so no explicit images URL needed.
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_TAGLINE,
    site: "@liveli",
    creator: "@liveli",
  },
  // Marketing pages are public; app pages override this to noindex
  // via the (app) layout's metadata.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  // Stop iOS Safari from auto-linking emails/phone numbers in body
  // copy. Liveli's marketing copy doesn't contain phone numbers we
  // want made interactive.
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#09090B" },
    { media: "(prefers-color-scheme: light)", color: "#F8F9FC" },
  ],
};

const themeScript = `(function(){try{var t=localStorage.getItem('liveli-theme')||'light';document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider afterSignOutUrl="/">
      <html
        lang="en"
        className={`${spaceGrotesk.variable} ${dmSans.variable} ${geistMono.variable} h-full antialiased`}
        suppressHydrationWarning
      >
        <head>
          {/* Favicon auto-discovered from src/app/icon.svg.
              Apple touch icon auto-discovered from src/app/apple-icon.tsx.
              Manifest auto-discovered from src/app/manifest.ts. */}
          <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        </head>
        <body className="min-h-full bg-background text-foreground">{children}</body>
      </html>
    </ClerkProvider>
  );
}
