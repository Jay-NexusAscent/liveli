// ============================================
// Liveli — Shared Icon Components
// Heroicons-style, 20×20 stroke icons. Use currentColor.
// ============================================

interface IconProps {
  className?: string;
  size?: number;
}

// ── Brand ──────────────────────────────────────

export function EcgLogo({ className, size = 28 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={Math.round((size / 40) * 32)}
      viewBox="0 0 40 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 18 L8 18 L11 23 L16 5 L20 27 L24 18 L28 18 L31 14 L34 18 L38 18"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Navigation / App tabs ──────────────────────

export function ChatIcon({ className }: IconProps) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5.5A2.5 2.5 0 015.5 3h9A2.5 2.5 0 0117 5.5v6A2.5 2.5 0 0114.5 14H9l-4 3.5V14H5.5A2.5 2.5 0 013 11.5v-6z" />
    </svg>
  );
}

export function ConnectIcon({ className }: IconProps) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="10" r="2.5" />
      <circle cx="15" cy="10" r="2.5" />
      <path d="M7.5 10h5" />
    </svg>
  );
}

export function DashboardIcon({ className }: IconProps) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="7" height="7" rx="1.5" />
      <rect x="11" y="2" width="7" height="7" rx="1.5" />
      <rect x="2" y="11" width="7" height="7" rx="1.5" />
      <rect x="11" y="11" width="7" height="7" rx="1.5" />
    </svg>
  );
}

// ── UI / Action ────────────────────────────────

export function ArrowRightIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10h12" />
      <path d="M11 5l5 5-5 5" />
    </svg>
  );
}

export function HamburgerIcon({ className }: IconProps) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function SunIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 1.5v2M10 16.5v2M3.5 10h-2M18.5 10h-2M5.2 5.2L3.8 3.8M16.2 16.2l-1.4-1.4M5.2 14.8L3.8 16.2M16.2 3.8l-1.4 1.4" />
    </svg>
  );
}

export function MoonIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 11.5A6.5 6.5 0 018.5 4 6.5 6.5 0 1016 11.5z" />
    </svg>
  );
}

// ── Data primitives ────────────────────────────

export function DatabaseIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="10" cy="4.5" rx="6" ry="2.5" />
      <path d="M4 4.5v11c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-11" />
      <path d="M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
    </svg>
  );
}

export function SparkleIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2v4M10 14v4M2 10h4M14 10h4M4.5 4.5l2.8 2.8M12.7 12.7l2.8 2.8M4.5 15.5l2.8-2.8M12.7 7.3l2.8-2.8" />
    </svg>
  );
}

export function InsightIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2.5a5.5 5.5 0 0 0-3.3 9.9c.5.4.8 1 .8 1.7v.4h5v-.4c0-.6.3-1.3.8-1.7A5.5 5.5 0 0 0 10 2.5Z" />
      <path d="M8 17h4M9 19h2" />
    </svg>
  );
}

export function TrendUpIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 14L8 9l3 3 6-6M13 7h4v4" />
    </svg>
  );
}

export function TrendDownIcon({ className }: IconProps) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6l5 5 3-3 6 6M13 13h4V9" />
    </svg>
  );
}

export function GripIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="7" cy="5" r="1.25" />
      <circle cx="13" cy="5" r="1.25" />
      <circle cx="7" cy="10" r="1.25" />
      <circle cx="13" cy="10" r="1.25" />
      <circle cx="7" cy="15" r="1.25" />
      <circle cx="13" cy="15" r="1.25" />
    </svg>
  );
}

export function ExpandIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8V3h5" />
      <path d="M17 8V3h-5" />
      <path d="M3 12v5h5" />
      <path d="M17 12v5h-5" />
    </svg>
  );
}

export function ShareIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="15" cy="4.5" r="2.25" />
      <circle cx="5" cy="10" r="2.25" />
      <circle cx="15" cy="15.5" r="2.25" />
      <path d="M7 9l6-3" />
      <path d="M7 11l6 3" />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M5 13H4.5A1.5 1.5 0 0 1 3 11.5v-7A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5V5" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10l4 4 8-9" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h14" />
      <path d="M8 5V3.5A1.5 1.5 0 0 1 9.5 2h1A1.5 1.5 0 0 1 12 3.5V5" />
      <path d="M5 5l1 11.5A1.5 1.5 0 0 0 7.5 18h5a1.5 1.5 0 0 0 1.5-1.5L15 5" />
      <path d="M8.5 9v6M11.5 9v6" />
    </svg>
  );
}

export function HistoryIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8a7 7 0 1 1 1.5 4" />
      <path d="M3 4v4h4" />
      <path d="M10 6v4l3 2" />
    </svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17l4-1L17 6l-3-3L4 13l-1 4z" />
      <path d="M12 5l3 3" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 1.5v2.5M10 16v2.5M3.5 10H1M19 10h-2.5M5.4 5.4L3.6 3.6M16.4 16.4l-1.8-1.8M5.4 14.6l-1.8 1.8M16.4 3.6l-1.8 1.8" />
    </svg>
  );
}

// ── Connector category icons ───────────────────
// Used by src/components/connections/brand-icon.tsx as the fallback
// when a source isn't in the simple-icons brand registry (Salesforce,
// Klaviyo, Amplitude, etc. — many enterprise brands pull their icons
// from simple-icons over trademark concerns). The category icon is
// always category-recognisable, so the catalogue card still
// communicates "this is a Payments source" / "this is Analytics"
// rather than the previous "everything's a database".

export function CreditCardIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="16" height="11" rx="2" />
      <path d="M2 9h16" />
      <path d="M5.5 13h2" />
    </svg>
  );
}

export function ShoppingBagIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h12l-1 10.5A1.5 1.5 0 0 1 13.5 19h-7A1.5 1.5 0 0 1 5 17.5L4 7z" />
      <path d="M7 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

export function ContactCardIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="16" height="12" rx="2" />
      <circle cx="7.5" cy="9" r="1.75" />
      <path d="M4.5 14c.4-1.4 1.6-2.5 3-2.5s2.6 1.1 3 2.5" />
      <path d="M12.5 8.5h3M12.5 11h3" />
    </svg>
  );
}

export function MegaphoneIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5v3l11 4V4.5l-11 4z" />
      <path d="M14 6.5v7" />
      <path d="M6 12v4l3 1v-3" />
    </svg>
  );
}

export function ChartLineIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17h14" />
      <path d="M3 3v14" />
      <path d="M6 13l3-4 3 2 4-6" />
    </svg>
  );
}

export function KanbanIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="4" height="14" rx="1" />
      <rect x="8.5" y="3" width="4" height="9" rx="1" />
      <rect x="14" y="3" width="4" height="11" rx="1" />
    </svg>
  );
}

export function HeadsetIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12V10a7 7 0 0 1 14 0v2" />
      <rect x="2.5" y="12" width="3" height="5" rx="1" />
      <rect x="14.5" y="12" width="3" height="5" rx="1" />
      <path d="M14.5 17v-1" />
    </svg>
  );
}

export function CoinIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="10" cy="6" rx="6" ry="2.5" />
      <path d="M4 6v3.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6" />
      <path d="M4 10v3.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V10" />
    </svg>
  );
}

export function ProductivityIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 2L4 11h5l-1 7 7-9h-5l1-7z" />
    </svg>
  );
}
