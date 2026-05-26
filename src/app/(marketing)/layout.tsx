import Script from "next/script";
import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

/**
 * Google Analytics 4 — scoped to the (marketing) route group only.
 *
 * Authenticated app surfaces under (app) don't load gtag, which keeps
 * us out of the worst of the GDPR/PECR consent footgun for logged-in
 * behavioural tracking. Marketing pages still need a cookie banner
 * before we have any meaningful EU/UK traffic — tracked in LIVELI-134.
 *
 * Env-var gated: NEXT_PUBLIC_GA_ID is set ONLY on Vercel's Production
 * environment scope. Preview and Development deployments leave it unset
 * so PR previews and local dev don't pollute prod analytics with our
 * own clicks. The component renders nothing when unset.
 */
const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_ID;

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-radial-glow min-h-screen">
      {GA_MEASUREMENT_ID && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-init" strategy="afterInteractive">
            {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`}
          </Script>
        </>
      )}
      <MarketingNav />
      <main className="relative z-[1]">{children}</main>
      <MarketingFooter />
    </div>
  );
}
