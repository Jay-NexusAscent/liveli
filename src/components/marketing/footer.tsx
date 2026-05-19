import Link from "next/link";
import { EcgLogo } from "@/components/icons";

/**
 * Sitemap-style footer with three columns (Product / Account / Contact)
 * plus a brand block on the left. Only links to surfaces that actually
 * exist — no placeholder "Coming soon" entries that erode trust.
 *
 * Bottom bar carries the copyright + jurisdiction line so the footer
 * still works as a legal/compliance landing zone.
 */

const PRODUCT_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Pricing", href: "/#pricing" },
];

const ACCOUNT_LINKS = [
  { label: "Start free", href: "/sign-up" },
  { label: "Sign in", href: "/sign-in" },
];

const CONTACT_LINKS = [
  { label: "hello@liveli.co.uk", href: "mailto:hello@liveli.co.uk" },
  {
    label: "Enterprise enquiries",
    href: "mailto:hello@liveli.co.uk?subject=Enterprise%20enquiry",
  },
];

export function MarketingFooter() {
  return (
    <footer className="mt-12 border-t border-border-subtle">
      <div className="container-page py-14 sm:py-16">
        <div className="grid gap-10 sm:gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          {/* Brand block */}
          <div className="flex flex-col gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2.5 text-text-primary"
              aria-label="Liveli home"
            >
              <EcgLogo className="text-accent" size={26} />
              <span className="text-[18px] font-semibold tracking-tight font-heading">
                Liveli
              </span>
            </Link>
            <p className="max-w-[280px] text-[14px] leading-relaxed text-text-secondary">
              Connect your data sources, get an AI analyst that answers in
              plain English. No SQL, no dashboards, no data engineer.
            </p>
          </div>

          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Account" links={ACCOUNT_LINKS} />
          <FooterColumn title="Contact" links={CONTACT_LINKS} />
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-border-subtle pt-6 text-[12px] text-text-tertiary sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} Liveli Ltd. All rights reserved.</span>
          <span>Built in the UK · EU data residency by default</span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <h4 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
        {title}
      </h4>
      <ul className="flex flex-col gap-2.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-[14px] text-text-secondary transition-colors hover:text-text-primary"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
