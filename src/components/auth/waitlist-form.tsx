"use client";

import { useState } from "react";
import { CheckIcon } from "@/components/icons";

type Status = "idle" | "submitting" | "done" | "error";

/**
 * Shown in place of Clerk's <SignUp> when self-serve registration is
 * capped (see lib/waitlist.ts). Captures an email so we can invite the
 * person when spots open up. Deliberately self-contained — no Clerk
 * dependency — because the whole point is that sign-up is closed.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setStatus("done");
    } catch {
      setError("Network error. Please try again.");
      setStatus("error");
    }
  };

  if (status === "done") {
    return (
      <div className="w-full max-w-[420px] rounded-xl border border-border bg-elevated p-8 text-center shadow-[0_0_40px_var(--accent-glow)]">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-accent-muted text-accent">
          <CheckIcon />
        </div>
        <h1 className="text-[20px] font-semibold tracking-tight text-text-primary font-heading">
          You&apos;re on the list
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
          Thanks for your interest in Liveli. We&apos;ll email{" "}
          <span className="font-medium text-text-primary">{email}</span> as soon
          as a spot opens up.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[420px] rounded-xl border border-border bg-elevated p-8 shadow-[0_0_40px_var(--accent-glow)]">
      <h1 className="text-[20px] font-semibold tracking-tight text-text-primary font-heading">
        Join the waitlist
      </h1>
      <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
        We&apos;ve hit capacity for now. Leave your email and we&apos;ll invite
        you the moment registration reopens.
      </p>

      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text-secondary">
            Email address
          </span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[14px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </label>

        {error && (
          <p className="text-[13px] text-[color:var(--status-error)]" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={status === "submitting"}
          className="mt-1 inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-[14px] font-semibold text-text-inverted transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === "submitting" ? "Joining…" : "Join waitlist"}
        </button>
      </form>
    </div>
  );
}
