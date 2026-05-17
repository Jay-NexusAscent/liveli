"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EcgLogo, ArrowRightIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "/chat";

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={cn(
        "fixed inset-x-0 top-0 z-40 transition-all duration-200",
        scrolled
          ? "border-b border-border-subtle bg-background/80 backdrop-blur-md"
          : "bg-transparent"
      )}
    >
      <div className="container-page flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 text-text-primary">
          <EcgLogo className="text-accent" size={28} />
          <span className="text-[18px] font-semibold tracking-tight font-heading">Liveli</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <Link href="/#features" className="text-[14px] text-text-secondary transition-colors hover:text-text-primary">
            Features
          </Link>
          <Link href="/#how-it-works" className="text-[14px] text-text-secondary transition-colors hover:text-text-primary">
            How it works
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/sign-in"
            className="hidden text-[14px] text-text-secondary transition-colors hover:text-text-primary sm:block"
          >
            Sign in
          </Link>
          <Link
            href={APP_URL}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[14px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_20px_var(--accent-glow-strong)]"
          >
            Start free
            <ArrowRightIcon />
          </Link>
        </div>
      </div>
    </nav>
  );
}
