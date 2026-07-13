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
 * The product's own mark (2026-07-13 refresh — supersedes the same day's
 * earlier two attempts: a hand-drawn toolbox-and-7 SVG, then a photographic/
 * glow version cropped from an AI-generated PNG) — a turquoise knot glyph on
 * a violet/navy rounded-square tile. This final version is real vector
 * source (public/marketing/branding/logo-mark.svg, part of a full brand kit
 * with a README covering every asset/variant), not a raster crop, so it's
 * crisp at any size with no transparency-recovery hackery needed. A plain
 * `<img>`, not `next/image` — SVGs aren't part of next/image's raster
 * optimization pipeline (same convention as AppNav.tsx's org-logo `<img>`).
 * Unlike every other icon in this file, this asset already bakes in its own
 * rounded-square badge/background — callers should size it directly (e.g.
 * `h-8 w-8`) rather than wrapping it in a separate colored badge `<span>`
 * the way the original SVG mark needed.
 */
export function ToolboxLogo({ className }: IconProps) {
  // eslint-disable-next-line @next/next/no-img-element -- local SVG, not worth routing through next/image's raster pipeline
  return <img src="/marketing/branding/logo-mark.svg" alt="Cin7 Core Toolbox" className={className} />;
}

/**
 * Horizontal lockup (icon + wordmark) of the same mark — white text, for a
 * dark background (the marketing page's nav/footer). Replaces rendering
 * `ToolboxLogo` and a `Cin7 Core Toolbox` text span as two separate elements
 * side by side.
 */
export function ToolboxLogoHorizontal({ className }: IconProps) {
  // eslint-disable-next-line @next/next/no-img-element -- local SVG, not worth routing through next/image's raster pipeline
  return <img src="/marketing/branding/logo-horizontal-dark.svg" alt="Cin7 Core Toolbox" className={className} />;
}

/** Same lockup, dark text — for a light background. Nothing in the app currently needs this (the one light-background usage, the dashboard header, already pairs the plain `ToolboxLogo` icon with its own separately-styled dark `<h1>`), but it's here since the brand kit ships it as a first-class variant. */
export function ToolboxLogoHorizontalLight({ className }: IconProps) {
  // eslint-disable-next-line @next/next/no-img-element -- local SVG, not worth routing through next/image's raster pipeline
  return <img src="/marketing/branding/logo-horizontal-light.svg" alt="Cin7 Core Toolbox" className={className} />;
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

export function DiagnosticsIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#f59e0b" to="#b45309">
      <path d="M14.5 3.5a3 3 0 0 0-4.2 4.2L4 14l2 2 6.3-6.3a3 3 0 0 0 4.2-4.2l-2.1 2.1-1.4-1.4 1.5-2.1Z" />
      <path d="m14 10 6 6-2 2-6-6" />
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

export function PricingIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#22c55e" to="#15803d">
      <path d="M12.5 3.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-.3.7l-9 9a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4l9-9a1 1 0 0 1 .7-.3Z" />
      <path d="M16.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
    </GradientIcon>
  );
}

export function ReplenishIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#7c3aed" to="#5b21b6">
      <rect x="3" y="10" width="7" height="10" rx="1" />
      <rect x="14" y="4" width="7" height="16" rx="1" />
      <path d="M6.5 7V5m0 2-1.5-1.5M6.5 7 8 5.5" />
    </GradientIcon>
  );
}

export function TeamIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#2563eb" to="#1d4ed8">
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="8.5" r="2.4" />
      <path d="M15.5 20a4.5 4.5 0 0 1 5.5-4.4" />
    </GradientIcon>
  );
}

/** Sidebar's compact icon-button row — not a module tile, just a shared icon. Cyan (distinct from every other icon here) for the global "sync sales now" action, available regardless of which page is open. */
export function SyncIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#0891b2" to="#155e75">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </GradientIcon>
  );
}

/** Sidebar's compact icon-button row — not a module tile, just a shared icon. Neutral slate, not a brand color, since signing out isn't a section of the app. */
export function SignOutIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#64748b" to="#334155">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </GradientIcon>
  );
}

/** Home page's "Ready to ship today" Overview widget — not a module tile, just a shared icon. Self-colored like every other icon (see SELF_COLORED_ICON_BADGE below), not a plain currentColor stroke meant for a colored badge behind it. */
export function ShipTodayIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#0ea5e9" to="#0369a1">
      <path d="M3 7h11v8H3z" />
      <path d="M14 10h4l3 3v2h-7z" />
      <circle cx="7" cy="17" r="1.5" />
      <circle cx="17" cy="17" r="1.5" />
    </GradientIcon>
  );
}

/** Home page's Stock Health breakdown Overview widget — not a module tile, just a shared icon. Self-colored like every other icon (see SELF_COLORED_ICON_BADGE below), not a plain currentColor stroke meant for a colored badge behind it. */
export function StockLevelsIcon({ className }: IconProps) {
  return (
    <GradientIcon className={className} from="#14b8a6" to="#0f766e">
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </GradientIcon>
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
export const SELF_COLORED_ICON_BADGE = "from-slate-50 to-slate-100";

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

export const PRICING_MODULE: ModuleConfig = {
  href: "/pricing",
  label: "Bulk Pricing",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: PricingIcon,
  blurb: "Filter one connected instance's products by Category, Supplier, or search, then set a flat price or apply a % increase across a chosen price tier — writes straight to Cin7.",
};

export const REPLENISH_MODULE: ModuleConfig = {
  href: "/replenish",
  label: "Replenish",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: ReplenishIcon,
  blurb: "Compare stock-on-hand per location against each product's reorder point (location-specific or global) and create real Stock Transfers from a chosen source location.",
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
// gated by requireSuperAdmin() in settings/diagnostics/layout.tsx, not by
// /admin's per-org visibility toggle, since it's not something any org
// (including a super-admin's own org) should ever be able to turn on/off.
export const DIAGNOSTICS_MODULE: ModuleConfig = {
  href: "/settings/diagnostics",
  label: "Diagnostics",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: DiagnosticsIcon,
  blurb: "Live debugging and field-discovery tools against a connected instance — super-admin only.",
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

// Same "not an org-toggleable module" reasoning as SECURITY_MODULE above —
// gated by requireOrgAdmin() in settings/members/layout.tsx (an org's own
// owner/admin, or a super-admin), not by /admin's per-org visibility toggle.
export const TEAM_MEMBERS_MODULE: ModuleConfig = {
  href: "/settings/members",
  label: "Team",
  gradient: SELF_COLORED_ICON_BADGE,
  Icon: TeamIcon,
  blurb: "Invite teammates and choose which modules each one can access.",
};

export const MODULES: ModuleConfig[] = [
  IMPORT_MODULE,
  TEMPLATES_MODULE,
  MIGRATE_MODULE,
  REPORTS_MODULE,
  AUDIT_MODULE,
  PRICING_MODULE,
  REPLENISH_MODULE,
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

/**
 * Merges the org-wide module gate (organizations.disabled_modules, set by a
 * super-admin) with one user's own allow-list (org_members.allowed_modules,
 * set by that org's own owner/admin on /settings/members) into the single
 * flat "modules this request can't see" list every consumer already expects
 * (middleware.ts, AppNav.tsx, page.tsx, tour-guide.tsx) — none of them need
 * to change, only the two places that *compute* this value do (see
 * getCurrentUserInfo() and middleware.ts's own independent copy).
 *
 * `userAllowedModules === null` means unrestricted — the user sees
 * everything the org itself allows (every existing user's default, and any
 * newly-invited one, until an owner/admin deliberately narrows them down).
 * A non-null array (including an empty one, meaning "denied everything") is
 * an explicit allow-list; the org's own disabled_modules always wins even
 * for a module the user's allow-list explicitly includes — a client can't
 * grant back something disabled org-wide.
 *
 * NOTE: if a module's href is ever renamed, any already-persisted
 * allowed_modules array referencing the old href silently stops matching
 * (the user just loses access to the renamed module until re-granted) — a
 * rename would need a data migration to update existing arrays too.
 */
export function computeEffectiveDisabledModules(orgDisabledModules: string[], userAllowedModules: string[] | null): string[] {
  if (userAllowedModules === null) return orgDisabledModules;
  const userDenied = MODULES.filter((m) => !userAllowedModules.includes(m.href)).map((m) => m.href);
  return [...new Set([...orgDisabledModules, ...userDenied])];
}
