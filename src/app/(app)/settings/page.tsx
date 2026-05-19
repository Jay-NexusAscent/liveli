import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SettingsDangerZone } from "@/components/settings/danger-zone";

export const runtime = "nodejs";

export default async function SettingsPage() {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");

  const cc = await clerkClient();
  const user = await cc.users.getUser(userId);
  const primaryEmail =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ?? "";

  const orgName = orgId
    ? (await cc.organizations.getOrganization({ organizationId: orgId })).name
    : null;

  return (
    <div className="container-page py-8">
      <header className="mb-8">
        <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">
          Settings
        </h1>
        <p className="mt-1 text-[14px] text-text-secondary">
          Manage your account and workspace.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="mb-4 text-[13px] font-medium uppercase tracking-wider text-text-tertiary">
          Account
        </h2>
        <div className="card-elevated p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" value={`${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "—"} />
            <Field label="Email" value={primaryEmail} />
            <Field label="Workspace" value={orgName ?? "(none — create one to use Liveli)"} />
            <Field label="User ID" value={userId} mono />
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-[13px] font-medium uppercase tracking-wider text-[color:var(--status-error)]">
          Danger zone
        </h2>
        <SettingsDangerZone email={primaryEmail} hasOrg={!!orgId} orgName={orgName} />
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      <div
        className={`text-[14px] text-text-primary ${mono ? "font-mono text-[12px] text-text-secondary" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}
