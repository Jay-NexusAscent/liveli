import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <SignIn
      appearance={{
        elements: {
          rootBox: "w-full max-w-[420px]",
          card: "bg-elevated border border-border shadow-[0_0_40px_var(--accent-glow)]",
        },
      }}
    />
  );
}
