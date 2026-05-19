import { MarketingHero } from "@/components/marketing/hero";
import { BuiltOnStrip } from "@/components/marketing/built-on";
import { MarketingFeatures } from "@/components/marketing/features";
import { MarketingPricing } from "@/components/marketing/pricing";

export default function MarketingHome() {
  return (
    <>
      <MarketingHero />
      <BuiltOnStrip />
      <MarketingFeatures />
      <MarketingPricing />
    </>
  );
}
