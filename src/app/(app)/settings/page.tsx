import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SettingsDangerZone } from "@/components/settings/danger-zone";
import { SettingsSection } from "@/components/settings/settings-section";
import { Field } from "@/components/settings/field";

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

      <SettingsSection title="Account">
        <div className="card-elevated p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              value={`${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "—"}
            />
            <Field label="Email" value={primaryEmail} />
            <Field
              label="Workspace"
              value={orgName ?? "(none — create one to use Liveli)"}
            />
            <Field label="User ID" value={userId} mono copyable />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Danger zone" variant="danger">
        <SettingsDangerZone
          email={primaryEmail}
          hasOrg={!!orgId}
          orgName={orgName}
        />
      </SettingsSection>
    </div>
  );
}
