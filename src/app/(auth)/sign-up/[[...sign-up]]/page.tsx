import { SignUp } from "@clerk/nextjs";
import { WaitlistForm } from "@/components/auth/waitlist-form";
import { registrationOpen } from "@/lib/waitlist";

// Re-evaluate the signup cap on every request rather than caching at
// build time — the count changes as people sign up, and a stale cached
// "open" would let registrations slip past the cap.
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const open = await registrationOpen();

  if (!open) {
    return <WaitlistForm />;
  }

  return (
    <SignUp
      appearance={{
        elements: {
          rootBox: "w-full max-w-[420px]",
          card: "bg-elevated border border-border shadow-[0_0_40px_var(--accent-glow)]",
        },
      }}
    />
  );
}
