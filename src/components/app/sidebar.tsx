"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import {
  EcgLogo,
  ChatIcon,
  ConnectIcon,
  DashboardIcon,
  HamburgerIcon,
  CloseIcon,
} from "@/components/icons";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Chat", href: "/chat", icon: ChatIcon },
  { label: "Connections", href: "/connections", icon: ConnectIcon },
  { label: "Dashboards", href: "/dashboards", icon: DashboardIcon },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 pt-6 pb-4">
        <EcgLogo className="text-accent shrink-0" size={26} />
        <span className="text-[17px] font-semibold tracking-tight text-text-primary font-heading">Liveli</span>
      </div>

      <div className="px-3 pb-4">
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl="/chat"
          afterCreateOrganizationUrl="/connections"
          appearance={{
            elements: {
              rootBox: "w-full",
              organizationSwitcherTrigger:
                "w-full rounded-md border border-border bg-elevated px-3 py-2 text-[13px] text-text-primary hover:bg-hover transition-colors",
            },
          }}
        />
      </div>

      <div className="mx-4 border-t border-border" />

      <nav className="flex-1 px-3 pt-4">
        <ul className="flex flex-col gap-0.5">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-all duration-200",
                    isActive
                      ? "bg-accent-muted text-accent shadow-[0_0_12px_rgba(129,140,248,0.15)]"
                      : "text-text-secondary hover:bg-hover hover:text-text-primary"
                  )}
                >
                  <item.icon className={cn("shrink-0", isActive ? "text-accent" : "text-text-tertiary")} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <UserButton />
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const pathname = usePathname();
  const [prevPathname, setPrevPathname] = useState(pathname);

  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setMobileOpen(false);
  }

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="flex items-center justify-center rounded-md p-1.5 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          aria-label="Open sidebar"
        >
          <HamburgerIcon />
        </button>
        <EcgLogo className="text-accent" size={22} />
        <span className="text-[15px] font-semibold text-text-primary font-heading">Liveli</span>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={closeMobile} aria-hidden="true" />
          <div className="relative flex h-full w-[260px] flex-col border-r border-border bg-surface shadow-xl">
            <button
              type="button"
              onClick={closeMobile}
              className="absolute right-4 top-4 flex items-center justify-center rounded-md p-1 text-text-secondary transition-colors hover:text-text-primary"
              aria-label="Close sidebar"
            >
              <CloseIcon />
            </button>
            <SidebarContent onNavigate={closeMobile} />
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-[240px] lg:flex-col lg:border-r lg:border-border lg:bg-surface">
        <SidebarContent />
      </aside>
    </>
  );
}
