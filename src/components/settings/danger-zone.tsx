"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

interface Props {
  email: string;
  hasOrg: boolean;
  orgName: string | null;
}

/**
 * Danger zone: nuke the entire account.
 *
 * UX:
 *  - Inline section explains the irreversible nature.
 *  - "Delete account" button opens a confirm modal.
 *  - Modal asks the user to type their email (matches Clerk primary).
 *  - On confirm: POST /api/account/delete (mode: "immediate") → wipes
 *    Liveli data, Clerk org, Clerk user. Then signOut() locally and
 *    redirect to /.
 */
export function SettingsDangerZone({ email, hasOrg, orgName }: Props) {
  const [open, setOpen] = useState(false);
  const [typedEmail, setTypedEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { signOut } = useClerk();

  const onConfirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmEmail: typedEmail,
          mode: "immediate",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      // Sign out locally → user lands on the marketing site.
      await signOut({ redirectUrl: "/" });
      // signOut redirects via Clerk, but in case it doesn't:
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const emailMatches = typedEmail.trim().toLowerCase() === email.toLowerCase();

  return (
    <>
      <div className="rounded-lg border border-[color:var(--status-error)]/40 bg-[color:var(--status-error)]/5 p-6">
        <h3 className="text-[15px] font-medium text-text-primary">
          Delete account and all data
        </h3>
        <p className="mt-1 text-[13px] text-text-secondary">
          {hasOrg
            ? `Permanently delete your account, workspace${orgName ? ` "${orgName}"` : ""}, and all connected data sources, charts, and dashboards. This cannot be undone.`
            : "Permanently delete your account. This cannot be undone."}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-md bg-[color:var(--status-error)] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[color:var(--status-error)]/90"
        >
          Delete account
        </button>
      </div>

      <Modal
        open={open}
        onClose={submitting ? () => {} : () => setOpen(false)}
        title="Delete your Liveli account?"
        maxWidth="max-w-lg"
      >
        <div className="space-y-4 text-[13px] text-text-secondary">
          <p>
            This will <span className="font-medium text-text-primary">immediately and permanently</span>:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>Delete your account and sign you out everywhere.</li>
            {hasOrg && (
              <>
                <li>
                  Delete your workspace{orgName ? ` "${orgName}"` : ""} and every
                  data source connected to it.
                </li>
                <li>
                  Delete all replicated data, charts, dashboards, and chat history.
                </li>
                <li>Cancel any future scheduled syncs.</li>
              </>
            )}
            <li>
              Securely remove your stored connection credentials.
            </li>
          </ul>

          <p className="rounded-md border border-border-subtle bg-elevated p-3 text-[12px]">
            <span className="font-medium text-text-primary">Note:</span> billing history is
            retained for legal compliance (tax records), but is not linked to a usable account
            and contains no operational data.
          </p>

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
              Type <span className="font-mono text-text-primary">{email}</span> to confirm:
            </label>
            <input
              type="email"
              autoComplete="off"
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
              placeholder={email}
              className="w-full rounded-md border border-border bg-elevated px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-[color:var(--status-error)] focus:outline-none focus:ring-2 focus:ring-[color:var(--status-error)]/30"
            />
          </div>

          {error && (
            <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-3 py-2 text-[12px] text-[color:var(--status-error)]">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={submitting}
              className="rounded-md border border-border px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!emailMatches || submitting}
              className={cn(
                "rounded-md bg-[color:var(--status-error)] px-4 py-2 text-[13px] font-medium text-white transition-all hover:bg-[color:var(--status-error)]/90",
                (!emailMatches || submitting) && "opacity-60"
              )}
            >
              {submitting ? "Deleting…" : "Permanently delete account"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
