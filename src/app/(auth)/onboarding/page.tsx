import { CreateOrganization } from "@clerk/nextjs";

export default function OnboardingPage() {
  return (
    <div className="flex w-full max-w-[460px] flex-col items-center gap-6">
      <div className="text-center">
        <h1 className="text-[26px] font-semibold tracking-tight text-text-primary font-heading">
          Create your workspace
        </h1>
        <p className="mt-2 text-[14px] text-text-secondary">
          A workspace holds your data sources, charts, and dashboards. You can invite teammates later.
        </p>
      </div>

      <CreateOrganization
        afterCreateOrganizationUrl="/chat"
        skipInvitationScreen
        appearance={{
          elements: {
            rootBox: "w-full",
            card: "bg-elevated border border-border shadow-[0_0_40px_var(--accent-glow)]",
          },
        }}
      />
    </div>
  );
}
