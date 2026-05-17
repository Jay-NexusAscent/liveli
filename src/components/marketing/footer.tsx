import Link from "next/link";
import { EcgLogo } from "@/components/icons";

export function MarketingFooter() {
  return (
    <footer className="border-t border-border-subtle">
      <div className="container-page flex flex-col items-start justify-between gap-6 py-10 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5 text-text-secondary">
          <EcgLogo className="text-accent" size={22} />
          <span className="text-[14px] font-semibold tracking-tight text-text-primary font-heading">Liveli</span>
          <span className="text-[13px] text-text-tertiary">— talk to your data.</span>
        </div>

        <div className="flex items-center gap-6 text-[13px] text-text-tertiary">
          <Link href="https://liveli.co.uk" className="transition-colors hover:text-text-primary">
            Voice agents
          </Link>
          <Link href="/sign-in" className="transition-colors hover:text-text-primary">
            Sign in
          </Link>
          <span>© {new Date().getFullYear()} Liveli Ltd</span>
        </div>
      </div>
    </footer>
  );
}
