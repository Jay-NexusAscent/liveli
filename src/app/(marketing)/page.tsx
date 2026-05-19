import { MarketingHero } from "@/components/marketing/hero";
import { MarketingFeatures } from "@/components/marketing/features";
import { MarketingPricing } from "@/components/marketing/pricing";

export default function MarketingHome() {
  return (
    <>
      <MarketingHero />
      <MarketingFeatures />
      <MarketingPricing />
    </>
  );
}
