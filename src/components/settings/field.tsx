"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Single field row inside a settings card. Label above value.
 *
 * `mono` values render in the monospace font at a smaller size and
 * tertiary colour — used for IDs, hashes, tokens. When `copyable` is
 * also set, the value becomes a button that copies the value to the
 * clipboard and flashes a check mark for 1.6s. The hover state is
 * intentionally subtle (border only); we don't want the field to
 * look like it's offering a primary action.
 *
 * Note: deliberately a client component because clipboard access
 * needs to run on the browser. The settings page wrapping this is
 * a server component (it reads Clerk's session); the Field renders
 * as a Client Boundary inside it.
 */
export function Field({
  label,
  value,
  mono = false,
  copyable = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Browsers without clipboard permission silently fail — fine,
      // the user can manually select. Nothing actionable to surface.
    }
  };

  const valueClasses = cn(
    mono
      ? "font-mono text-[12px] text-text-secondary"
      : "text-[14px] text-text-primary"
  );

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      {copyable ? (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${label} to clipboard`}
          className={cn(
            "group inline-flex max-w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-0.5 transition-colors -ml-1.5 hover:border-border hover:bg-hover",
            valueClasses
          )}
        >
          <span className="truncate">{value}</span>
          <span
            className={cn(
              "shrink-0 transition-colors",
              copied ? "text-accent" : "text-text-tertiary group-hover:text-text-secondary"
            )}
            aria-hidden
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </span>
        </button>
      ) : (
        <div className={valueClasses}>{value}</div>
      )}
    </div>
  );
}
