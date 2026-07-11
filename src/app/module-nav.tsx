/**
 * Single source of truth for every top-level module's icon, gradient, and
 * short blurb — shared by the sidebar nav (AppNav.tsx), the home page's
 * module tiles, and each module page's own ModuleHeader banner, so the same
 * icon/gradient never has to be hand-copied into three places.
 */

import Image from "next/image";
import { useId } from "react";

type IconProps = { className?: string };

/**
 * Matches the new PNG module icons' look (bold stroke, the icon carries its
 * own color) for the remaining modules that don't have a designed image yet
 * — Instances/Activity/Admin/Security/Billing. `useId` gives each rendered
 * instance its own gradient id; without it, two instances of the same icon
 * on one page (e.g. Instances appears in both the sidebar nav and the home
 * page's tile grid simultaneously) would collide on a hardcoded id.
 */
function GradientIcon({ className, from, to, children }: { className?: string; from: string; to: string; children: React.ReactNode }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <g stroke={`url(#${gradientId})`}>{children}</g>
    </svg>
  );
}

/**
 * Six of the module icons below (Import/Templates/Migrate/Reports/Audit/
 * Health) render one of these designed PNGs instead of an inline SVG —
 * confirmed 2026-07-11 to stay legible even at a true, unsmoothed 32px
 * (unlike an earlier glassy-illustration draft, which didn't). `next/image`
 * (not a plain <img>) since these are ~0.9MB source files requested on every
 * authenticated page via the sidebar nav — its optimizer serves a properly
 * sized/compressed version instead of the full original each time. width/
 * height are just the intrinsic aspect ratio (all square); the `className`
 * each call site already passes (e.g. "h-5 w-5") controls the layout box,
 * same contract every other icon component here already has — but confirmed
 * live 2026-07-11 that box reads as mostly empty badge padding around a tiny
 * icon, unlike the old thin-stroke SVGs it replaced (which were designed to
 * have that breathing room). A `scale` transform enlarges the rendered image
 * well past its own box without changing that box's layout size — none of
 * the three badges this renders into (AppNav.tsx/page.tsx/ModuleHeader.tsx)
 * clip overflow, so the enlarged image just visually fills more of the
 * badge around it instead of pushing other elements.
 */
function ModuleImageIcon({ src, className }: { src: string; className?: string }) {
  return <Image src={src} alt="" width={64} height={64} className={`${className ?? ""} scale-[1.7]`} />;
}

/**
 * The product's own mark — a toolbox whose latch is drawn as a "7", a quiet
 * nod to Cin7 without reproducing their actual logo/trademark. Used on the
 * home page next to the product name.
 */
export function ToolboxLogo({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <rect x="3" y="8" width="18" height="11" rx="2" />
      <path d="M3 13h6M15 13h6" />
      <path d="M10.3 11.3h3.4l-2 5" />
    </svg>
  );
}

export function ImportIcon({ className }: IconProps) {
  return <ModuleImageIcon src="/icons/import.png" className={className} />;
}

export function TemplateIcon({ className }: IconProps) {
  return <ModuleImageIcon src="/icons/templates.png" className={className} />;
}

export function MigrateIcon({ className }: IconProps) {
  return <ModuleImageIcon src="/icons/migrate.png" className={className} />;
}

export function ReportsIcon({ className }: IconProps) {
  return <ModuleImageIcon src="/icons/reports.png" className={className} />;
}

export function InstancesIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#64748b" to="#334155">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </GradientIcon>
  );
}

export function AuditIcon({ className }: IconProps) {
  return <ModuleImageIcon src="/icons/audit.png" className={className} />;
}

export function HealthIcon({ className }: IconProps) {
  return <ModuleImageIcon src="/icons/health.png" className={className} />;
}

export function ActivityIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#14b8a6" to="#0f766e">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </GradientIcon>
  );
}

export function AdminIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#d946ef" to="#a21caf">
      <circle cx="12" cy="9" r="2.5" />
      <path d="M12 3a9 9 0 0 0-9 9c0 3 1.6 4.8 3.5 6M12 3a9 9 0 0 1 9 9c0 3-1.6 4.8-3.5 6M8 21c.7-2.3 2.2-3.5 4-3.5s3.3 1.2 4 3.5" />
    </GradientIcon>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#f43f5e" to="#be123c">
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z" />
      <path d="m9.5 12 1.8 1.8L15 10" />
    </GradientIcon>
  );
}

export function BillingIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#10b981" to="#047857">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
      <path d="M7 14h4" />
    </GradientIcon>
  );
}

/** Home page's "Ready to ship today" Overview widget — not a module tile, just a shared icon. */
export function ShipTodayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 7h11v8H3z" />
      <path d="M14 10h4l3 3v2h-7z" />
      <circle cx="7" cy="17" r="1.5" />
      <circle cx="17" cy="17" r="1.5" />
    </svg>
  );
}

/** Home page's Stock Health breakdown Overview widget — not a module tile, just a shared icon. */
export function StockLevelsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  );
}

export interface ModuleConfig {
  href: string;
  label: string;
  /** Purely for visual variety/personality — no semantic meaning beyond "this section has a distinct identity." */
  gradient: string;
  Icon: (props: IconProps) => React.ReactElement;
  /** Short blurb for the home page's module tiles. Each page's own ModuleHeader keeps its own, more detailed explanation. */
  blurb: string;
}

// Every module's icon now carries its own color — six as a designed PNG
// (ModuleImageIcon), the rest as a gradient-stroke SVG (GradientIcon) — so a
// colored gradient badge behind any of them would double up the color
// treatment (and risk poor contrast where the icon's own color is close to
// the badge's). Every module below shares this one plain, neutral badge.
const SELF_COLORED_ICON_BADGE = "from-slate-50 to-slate-100";

export const IMPORT_MODULE: ModuleConfig = {
  href: "/import",
  label: "Import & Sync",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: ImportIcon,
  blurb: "Upload a Products, Assembly BOM, or Production BOM CSV, then push it to one or more connected Cin7 Core instances.",
};

export const TEMPLATES_MODULE: ModuleConfig = {
  href: "/templates",
  label: "Templates",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: TemplateIcon,
  blurb: "Download a CSV to edit and reimport — either the hub's own canonical data, or a full-fidelity export pulled live from a chosen instance.",
};

export const MIGRATE_MODULE: ModuleConfig = {
  href: "/migrate",
  label: "Migrate",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: MigrateIcon,
  blurb: "Pull every Product, Assembly BOM, Customer, and Supplier live from one connected instance, then push the pulled data into another.",
};

export const REPORTS_MODULE: ModuleConfig = {
  href: "/reports",
  label: "Reporting",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: ReportsIcon,
  blurb: "A growing hub of reports pulled from your connected Cin7 instances — Sales (revenue/COGS/profit/margin%) and Assemblies (quantity + BOM cost), with more to come.",
};

export const AUDIT_MODULE: ModuleConfig = {
  href: "/audit",
  label: "Data Audit",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: AuditIcon,
  blurb: "Scan a connected instance's products for consistency and accuracy gaps — missing Brand, no sales price, incomplete inventory setup, missing GL accounts, near-duplicate categories — and bulk-fix them.",
};

export const HEALTH_MODULE: ModuleConfig = {
  href: "/health",
  label: "System Health",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: HealthIcon,
  blurb: "A scorecard across Sales, Purchases, Stock Transfers, Assemblies, Production Orders, and product data quality — one overall health score per connected instance.",
};

export const INSTANCES_MODULE: ModuleConfig = {
  href: "/settings/instances",
  label: "Cin7 Instances",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: InstancesIcon,
  blurb: "Connect, edit, or remove the Cin7 Core instances this organization syncs to.",
};

export const ACTIVITY_MODULE: ModuleConfig = {
  href: "/activity",
  label: "Activity Log",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: ActivityIcon,
  blurb: "Every live write this app has made to your connected Cin7 instances — Data Audit fixes/merges and sync pushes — with who triggered it and when.",
};

export const ADMIN_MODULE: ModuleConfig = {
  href: "/admin",
  label: "Admin",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: AdminIcon,
  blurb: "Create organizations, invite users, and manage org branding.",
};

// Per-user account settings, not an org-toggleable module — deliberately
// left out of MODULES (no home tile, not listed in /admin's per-org
// visibility toggle). Only used to give /settings/security's own
// ModuleHeader the same visual language as everything else.
export const SECURITY_MODULE: ModuleConfig = {
  href: "/settings/security",
  label: "Security",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: ShieldIcon,
  blurb: "Set up two-factor authentication with an authenticator app.",
};

// Same "not an org-toggleable module" reasoning as SECURITY_MODULE above —
// billing status is per-org but the settings page itself isn't something
// /admin's per-org visibility toggle should ever hide.
export const BILLING_MODULE: ModuleConfig = {
  href: "/settings/billing",
  label: "Billing",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: BillingIcon,
  blurb: "Trial status and subscription — managed through Lemon Squeezy.",
};

export const MODULES: ModuleConfig[] = [
  IMPORT_MODULE,
  TEMPLATES_MODULE,
  MIGRATE_MODULE,
  REPORTS_MODULE,
  AUDIT_MODULE,
  HEALTH_MODULE,
  INSTANCES_MODULE,
  ACTIVITY_MODULE,
];

/**
 * If `pathname` falls under a module this org has disabled, returns that
 * module (used by middleware.ts to block direct URL access, and by the
 * home page to explain why it redirected here) — otherwise undefined.
 * Pure and Next/Supabase-free so it's directly unit-testable.
 */
export function findBlockedModule(pathname: string, disabledModules: string[]): ModuleConfig | undefined {
  return MODULES.find((m) => disabledModules.includes(m.href) && pathname.startsWith(m.href));
}
