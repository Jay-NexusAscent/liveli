import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-radial-glow min-h-screen">
      <MarketingNav />
      <main className="relative z-[1]">{children}</main>
      <MarketingFooter />
    </div>
  );
}
