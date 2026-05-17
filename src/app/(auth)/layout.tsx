import Link from "next/link";
import { EcgLogo } from "@/components/icons";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-radial-glow flex min-h-screen flex-col">
      <header className="container-page flex h-16 items-center">
        <Link href="/" className="flex items-center gap-2.5 text-text-primary">
          <EcgLogo className="text-accent" size={26} />
          <span className="text-[17px] font-semibold tracking-tight font-heading">Liveli</span>
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">{children}</main>
    </div>
  );
}
