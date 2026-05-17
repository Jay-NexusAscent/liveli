import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
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
