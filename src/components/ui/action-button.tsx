import Link from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Shared pill-button primitive used everywhere the app shows a
 * "click to do something" affordance — Save, Connect, New chat,
 * Open in chat, Suggest insights, Re-evaluate, etc. Replaces the
 * inline className-soup that was duplicated across ~30 callsites.
 *
 * Three variants:
 *   - primary  — solid accent fill, white-on-indigo style. Primary
 *                CTAs / form submits.
 *   - muted    — accent-tinted background, accent text. Flips to
 *                solid accent on hover. Secondary CTAs that promote
 *                themselves on interaction (Open in chat, Save).
 *   - outline  — bordered neutral. Tertiary actions in card chrome
 *                (Edit, Pause, Sync now).
 *
 * Four sizes (xs / sm / md / lg) line up with the existing inline
 * usages: xs for compact card chrome, sm for inline page actions,
 * md for form submits, lg for marketing hero CTAs.
 *
 * Pass `href` to render as a Next.js Link instead of a button. The
 * styling is identical; only the underlying element changes. Keeps
 * /chat/history's "Start a chat" link visually aligned with the
 * "Re-evaluate" button on /insights even though one navigates and
 * the other fires an onClick.
 *
 * `glow` is opt-in (primary variant only) — adds a soft accent
 * glow on hover for the hero CTAs in wizards and not-found.
 */

type Variant = "primary" | "muted" | "outline";
type Size = "xs" | "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-accent text-text-inverted hover:bg-accent-hover",
  muted:
    "bg-accent-muted text-accent hover:bg-accent hover:text-text-inverted",
  outline:
    "border border-border bg-transparent text-text-secondary hover:bg-hover hover:text-text-primary",
};

const SIZE_CLASSES: Record<Size, string> = {
  xs: "gap-1 px-2.5 py-1 text-[11px]",
  sm: "gap-1.5 px-3 py-1.5 text-[12px]",
  md: "gap-1.5 px-4 py-2 text-[13px]",
  lg: "gap-2 px-6 py-3 text-[15px]",
};

interface BaseProps {
  variant?: Variant;
  size?: Size;
  /** `md` rounds to `rounded-md`; `full` to `rounded-full` (pill). */
  rounded?: "md" | "full";
  /**
   * Adds a soft accent glow on hover. Only meaningful for the
   * primary variant — outline/muted variants don't visually
   * benefit. Use sparingly for hero CTAs.
   */
  glow?: boolean;
  className?: string;
  children: ReactNode;
}

type AsButton = BaseProps & {
  href?: undefined;
} & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className" | "children"
  >;

type AsLink = BaseProps & {
  href: string;
} & Omit<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    "className" | "children" | "href"
  >;

export type ActionButtonProps = AsButton | AsLink;

export function ActionButton(props: ActionButtonProps) {
  const {
    variant = "outline",
    size = "sm",
    rounded = "md",
    glow = false,
    className,
    children,
    ...rest
  } = props;

  const classes = cn(
    "inline-flex items-center font-medium transition-colors disabled:opacity-60",
    SIZE_CLASSES[size],
    rounded === "full" ? "rounded-full" : "rounded-md",
    VARIANT_CLASSES[variant],
    glow &&
      variant === "primary" &&
      "transition-all hover:shadow-[0_0_20px_var(--accent-glow-strong)]",
    className
  );

  // Discriminate on `href` at runtime — TS narrows via the union.
  // Both branches receive the same className; only the underlying
  // element and ref behaviour change.
  if ("href" in rest && typeof rest.href === "string") {
    const { href, ...linkRest } = rest as { href: string } & Omit<
      AnchorHTMLAttributes<HTMLAnchorElement>,
      "href"
    >;
    return (
      <Link href={href} className={classes} {...linkRest}>
        {children}
      </Link>
    );
  }

  return (
    <button
      className={classes}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  );
}
