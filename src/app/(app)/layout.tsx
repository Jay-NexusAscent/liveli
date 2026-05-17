import { Sidebar } from "@/components/app/sidebar";

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
