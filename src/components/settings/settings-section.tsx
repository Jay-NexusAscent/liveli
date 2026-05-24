import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Settings section scaffold — H2 label + content slot.
 *
 * Two variants:
 *   - default — neutral tertiary heading, used for routine sections.
 *   - danger  — red `--status-error` heading, signals destructive
 *               actions. Pair with a content block that visually
 *               echoes the alert state (red-tinted border + bg).
 *
 * Why a component instead of inline JSX: both sections of the
 * Settings page (and any future ones) used identical scaffolding,
 * which made the page harder to scan. Extracting also locks the
 * heading-mb-and-typography in one place so they can't drift.
 */
export function SettingsSection({
  title,
  variant = "default",
  children,
}: {
  title: string;
  variant?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <section className={cn(variant === "default" ? "mb-10" : "")}>
      <h2
        className={cn(
          "mb-4 text-[13px] font-medium uppercase tracking-wider",
          variant === "danger"
            ? "text-[color:var(--status-error)]"
            : "text-text-tertiary"
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
