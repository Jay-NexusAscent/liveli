"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EcgLogo, ArrowRightIcon } from "@/components/icons";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/utils";

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navLinks = [
    { href: "/#features", label: "Features" },
    { href: "/#how-it-works", label: "How it works" },
    { href: "/#pricing", label: "Pricing" },
  ];

  return (
    <nav
      className={cn(
        "fixed inset-x-0 top-0 z-40 transition-all duration-300",
        scrolled
          ? "border-b border-border-subtle bg-background/70 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      )}
    >
      <div
        className={cn(
          "flex items-center px-6 transition-[height] duration-300 lg:px-10",
          scrolled ? "h-14" : "h-16"
        )}
      >
        {/* Left cluster — logo + nav links */}
        <Link
          href="/"
          className="flex items-center gap-2.5 text-text-primary"
          aria-label="Liveli home"
        >
          <EcgLogo className="text-accent" size={28} />
          <span className="text-[18px] font-semibold tracking-tight font-heading">
            Liveli
          </span>
        </Link>

        <div className="ml-10 hidden items-center gap-7 md:flex">
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="group relative text-[14px] text-text-secondary transition-colors hover:text-text-primary"
            >
              {l.label}
              <span className="absolute -bottom-1 left-0 h-px w-0 bg-accent transition-all duration-300 group-hover:w-full" />
            </Link>
          ))}
        </div>

        {/* Right cluster — pushed to the far right via ml-auto */}
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <Link
            href="/sign-in"
            className="hidden text-[14px] text-text-secondary transition-colors hover:text-text-primary sm:block"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[14px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_20px_var(--accent-glow-strong)] hover:scale-[1.02] active:scale-[0.98]"
          >
            Start free
            <ArrowRightIcon />
          </Link>
        </div>
      </div>
    </nav>
  );
}
