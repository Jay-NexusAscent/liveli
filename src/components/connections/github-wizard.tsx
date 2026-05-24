"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  Field,
  SyncFrequencyField,
  formatError,
  inputClass,
  readResponse,
  type SyncFrequency,
} from "@/components/connections/wizard-shared";

interface GitHubWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface FormState {
  name: string;
  accessToken: string;
  /** Comma-separated "owner/repo" entries — wizard parses, sends as JSON array. */
  repositories: string;
  syncFrequency: SyncFrequency;
}

const initialForm: FormState = {
  name: "GitHub",
  accessToken: "",
  repositories: "",
  syncFrequency: "1h",
};

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function GitHubWizard({ open, onClose, onConnected }: GitHubWizardProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const token = form.accessToken.trim();
    // GitHub PATs: classic = "ghp_*", fine-grained = "github_pat_*".
    // Accept both shapes.
    if (!/^(ghp_|github_pat_)/.test(token)) {
      setError(
        "GitHub Personal Access Token required. Classic tokens start with ghp_; fine-grained tokens with github_pat_. Create one at github.com/settings/tokens with `repo` + `read:org` scopes (classic) or repository content read + metadata read (fine-grained)."
      );
      return;
    }

    const repos = form.repositories
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    if (repos.length === 0) {
      setError(
        "At least one repository is required. Format: owner/repo, comma-separated for multiple (e.g. vercel/next.js, anthropics/anthropic-sdk-python)."
      );
      return;
    }

    const badRepo = repos.find((r) => !REPO_PATTERN.test(r));
    if (badRepo) {
      setError(
        `"${badRepo}" doesn't look like a GitHub repository path. Use the owner/repo format (e.g. vercel/next.js).`
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/connections/github/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          accessToken: token,
          repositories: repos,
          syncFrequency: form.syncFrequency,
        }),
      });
      const data = await readResponse(res);
      if (!res.ok) throw new Error(formatError(data, res.status));

      const connectorId = data.connectorId as string | undefined;
      if (autoSync && connectorId) {
        const syncRes = await fetch(`/api/connections/${connectorId}/sync`, { method: "POST" });
        const syncData = await readResponse(syncRes);
        if (!syncRes.ok) {
          setError(`Saved, but sync failed to start:\n${formatError(syncData, syncRes.status)}`);
          setSubmitting(false);
          onConnected();
          return;
        }
      }

      setForm(initialForm);
      onConnected();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect GitHub" maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Connection name">
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Personal Access Token"
          hint="github.com/settings/tokens. Classic with `repo` + `read:org` scopes, or fine-grained with content read + metadata read on the repos below."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={form.accessToken}
            onChange={(e) => update("accessToken", e.target.value)}
            placeholder="ghp_… or github_pat_…"
            className={inputClass}
          />
        </Field>

        <Field
          label="Repositories"
          hint="Comma-separated owner/repo entries. Example: vercel/next.js, anthropics/anthropic-sdk-python"
        >
          <input
            type="text"
            required
            value={form.repositories}
            onChange={(e) => update("repositories", e.target.value)}
            placeholder="owner/repo, owner/another-repo"
            className={inputClass}
          />
        </Field>

        <SyncFrequencyField
          value={form.syncFrequency}
          onChange={(v) => update("syncFrequency", v)}
        />

        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => setAutoSync(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Start the first sync immediately after connecting
        </label>

        {error && (
          <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-3 py-2 text-[12px] whitespace-pre-wrap text-[color:var(--status-error)]">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-border px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={cn(
              "rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-text-inverted transition-all hover:bg-accent-hover hover:shadow-[0_0_20px_var(--accent-glow-strong)]",
              submitting && "opacity-60"
            )}
          >
            {submitting ? "Connecting…" : autoSync ? "Connect & sync" : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
