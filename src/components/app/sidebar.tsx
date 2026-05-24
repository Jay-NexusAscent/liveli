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
  HistoryIcon,
  InsightIcon,
  SettingsIcon,
} from "@/components/icons";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/utils";

/**
 * Sidebar nav, split into two groups separated by a subtle uppercase
 * label. The split is conceptual, not arbitrary:
 *
 *   Workspace — the four surfaces the user works IN day-to-day.
 *     Chat / History / Insights / Dashboards.
 *
 *   Account  — administrative surfaces touched occasionally.
 *     Connections / Settings.
 *
 * Reduces cognitive load — six flat items become two tight groups —
 * and matches the pattern used by Linear / Vercel / most app shells.
 */
const navGroups: Array<{
  label: string;
  items: Array<{ label: string; href: string; icon: typeof ChatIcon }>;
}> = [
  {
    label: "Workspace",
    items: [
      { label: "Chat", href: "/chat", icon: ChatIcon },
      { label: "History", href: "/chat/history", icon: HistoryIcon },
      { label: "Insights", href: "/insights", icon: InsightIcon },
      { label: "Dashboards", href: "/dashboards", icon: DashboardIcon },
    ],
  },
  {
    label: "Account",
    items: [
      { label: "Connections", href: "/connections", icon: ConnectIcon },
      { label: "Settings", href: "/settings", icon: SettingsIcon },
    ],
  },
];

// Flat list used for active-state longest-prefix matching, derived
// once at module load so the per-render path doesn't re-flatten.
const allNavItems = navGroups.flatMap((g) => g.items);

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      {/* Top — wordmark only. The Clerk account chrome (organization
          switcher + user button) used to sit here at the top, with
          the user button orphaned at the bottom. That split read as
          two unrelated bubbles in different corners. Both live in
          the footer now so the "account" surface is one cohesive
          block; the top of the sidebar is reserved for brand. */}
      <div className="flex items-center gap-2.5 px-5 pt-6 pb-4">
        <EcgLogo className="text-accent shrink-0" size={26} />
        <span className="text-[17px] font-semibold tracking-tight text-text-primary font-heading">
          Liveli
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3">
        {navGroups.map((group, gi) => (
          <div key={group.label} className={cn(gi > 0 && "mt-6")}>
            <div className="px-3 pb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
              {group.label}
            </div>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                // Active when the path matches this nav item AND no
                // other nav item is a longer prefix of the path.
                // Without the longest-match check, `/chat/history`
                // would mark both "Chat" (/chat) and "History"
                // (/chat/history) as active. Match runs across the
                // flat allNavItems so cross-group prefixes (e.g.
                // Workspace.Chat vs Workspace.History) resolve
                // correctly.
                const isActive =
                  pathname.startsWith(item.href) &&
                  !allNavItems.some(
                    (other) =>
                      other.href !== item.href &&
                      other.href.length > item.href.length &&
                      pathname.startsWith(other.href)
                  );
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-all duration-200",
                        isActive
                          ? "bg-accent-muted text-accent shadow-[0_0_12px_var(--accent-glow)]"
                          : "text-text-secondary hover:bg-hover hover:text-text-primary"
                      )}
                    >
                      <item.icon
                        className={cn(
                          "shrink-0",
                          isActive ? "text-accent" : "text-text-tertiary"
                        )}
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Unified account footer — org switcher above, user button +
          theme toggle below. One visual block bordered off from the
          nav. Pattern matches Linear / Vercel / Notion sidebars
          where account chrome lives in a single sidebar-footer
          rather than split between top and bottom corners. */}
      <div className="space-y-2 border-t border-border p-3">
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl="/chat"
          afterCreateOrganizationUrl="/connections"
          appearance={{
            elements: {
              rootBox: "w-full",
              organizationSwitcherTrigger:
                "w-full justify-between rounded-md border border-border bg-elevated px-3 py-2 text-[13px] text-text-primary hover:bg-hover transition-colors",
            },
          }}
        />
        <div className="flex items-center justify-between gap-2 pt-1">
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
