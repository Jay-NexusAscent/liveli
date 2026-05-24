import type { ReactNode } from "react";

/**
 * Shared empty-state card. Centred composition with a tinted-square
 * icon, a heading, a max-w-md description, and an optional action.
 *
 * Used by /dashboards, /chat/history, and /insights — all three had
 * the same `card-elevated flex flex-col items-center justify-center
 * gap-3 py-20 text-center` scaffolding inlined with bespoke icons /
 * copy. Extracted so the empty-state language (typography, icon
 * tile, spacing) lives in one place and the per-route content stays
 * focused on what's actually different: the icon, the copy, the CTA.
 *
 * `description` and `action` accept ReactNode because the existing
 * sites use entities (`&apos;`, `&ldquo;`) and arbitrary elements
 * (Link, button) inside them. Forcing string types would be a
 * regression.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card-elevated flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-muted text-accent">
        {icon}
      </div>
      <h2 className="text-[18px] font-semibold tracking-tight text-text-primary font-heading">
        {title}
      </h2>
      <p className="max-w-md text-[14px] text-text-secondary">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
