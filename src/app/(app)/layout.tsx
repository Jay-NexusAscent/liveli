import type { Metadata } from "next";
import { Sidebar } from "@/components/app/sidebar";

/**
 * Authenticated surfaces (Chat, Connections, Dashboards, Insights,
 * Settings) are not for public indexing. Search engines hitting an
 * app URL would land on a Clerk redirect anyway, but explicit noindex
 * is cleaner — keeps these out of SERPs and stops social previews
 * from leaking page titles that imply Liveli has tenants by name.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="min-h-screen lg:pl-[240px]">
        <div className="h-14 lg:hidden" />
        {children}
      </main>
    </div>
  );
}
