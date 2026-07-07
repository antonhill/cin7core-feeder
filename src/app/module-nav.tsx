/**
 * Single source of truth for every top-level module's icon, gradient, and
 * short blurb — shared by the sidebar nav (AppNav.tsx), the home page's
 * module tiles, and each module page's own ModuleHeader banner, so the same
 * icon/gradient never has to be hand-copied into three places.
 */

type IconProps = { className?: string };

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
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

export function TemplateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

export function MigrateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m7 8-4 4 4 4M3 12h13.5M17 4l4 4-4 4M21 8H7.5" />
    </svg>
  );
}

export function ReportsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 20V10m6 10V4m6 16v-7" />
    </svg>
  );
}

export function InstancesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  );
}

export function AuditIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 11.5 11 13.5 15.5 9M12 3l7 3v6c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V6l7-3Z" />
    </svg>
  );
}

export function HealthIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  );
}

export function ActivityIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function AdminIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="9" r="2.5" />
      <path d="M12 3a9 9 0 0 0-9 9c0 3 1.6 4.8 3.5 6M12 3a9 9 0 0 1 9 9c0 3-1.6 4.8-3.5 6M8 21c.7-2.3 2.2-3.5 4-3.5s3.3 1.2 4 3.5" />
    </svg>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z" />
      <path d="m9.5 12 1.8 1.8L15 10" />
    </svg>
  );
}

export function AssemblyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
      <path d="M4 7.5 12 12m0 0 8-4.5M12 12v9" />
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

export const IMPORT_MODULE: ModuleConfig = {
  href: "/import",
  label: "Import & Sync",
  gradient: "from-indigo-500 to-indigo-700",
  Icon: ImportIcon,
  blurb: "Upload a Products, Assembly BOM, or Production BOM CSV, then push it to one or more connected Cin7 Core instances.",
};

export const TEMPLATES_MODULE: ModuleConfig = {
  href: "/templates",
  label: "Templates",
  gradient: "from-violet-500 to-violet-700",
  Icon: TemplateIcon,
  blurb: "Download a CSV to edit and reimport — either the hub's own canonical data, or a full-fidelity export pulled live from a chosen instance.",
};

export const MIGRATE_MODULE: ModuleConfig = {
  href: "/migrate",
  label: "Migrate",
  gradient: "from-cyan-500 to-cyan-700",
  Icon: MigrateIcon,
  blurb: "Pull every Product, Assembly BOM, Customer, and Supplier live from one connected instance, then push the pulled data into another.",
};

export const REPORTS_MODULE: ModuleConfig = {
  href: "/reports",
  label: "Reports",
  gradient: "from-amber-500 to-amber-600",
  Icon: ReportsIcon,
  blurb: "Revenue, COGS, profit, and margin% per product sold, across every invoiced sale pulled from your connected Cin7 instances.",
};

export const AUDIT_MODULE: ModuleConfig = {
  href: "/audit",
  label: "Data Audit",
  gradient: "from-rose-500 to-rose-700",
  Icon: AuditIcon,
  blurb: "Scan a connected instance's products for consistency and accuracy gaps — missing Brand, no sales price, incomplete inventory setup, missing GL accounts, near-duplicate categories — and bulk-fix them.",
};

export const HEALTH_MODULE: ModuleConfig = {
  href: "/health",
  label: "System Health",
  gradient: "from-emerald-500 to-emerald-700",
  Icon: HealthIcon,
  blurb: "A scorecard across Sales, Purchases, Stock Transfers, Assemblies, Production Orders, and product data quality — one overall health score per connected instance.",
};

export const ASSEMBLIES_MODULE: ModuleConfig = {
  href: "/assemblies",
  label: "Assemblies",
  gradient: "from-orange-500 to-orange-700",
  Icon: AssemblyIcon,
  blurb: "Every assembly build pulled live from a connected instance — quantity and total BOM cost per build, filterable by Draft, Authorised, In Progress, or Completed.",
};

export const INSTANCES_MODULE: ModuleConfig = {
  href: "/settings/instances",
  label: "Cin7 Instances",
  gradient: "from-slate-500 to-slate-700",
  Icon: InstancesIcon,
  blurb: "Connect, edit, or remove the Cin7 Core instances this organization syncs to.",
};

export const ACTIVITY_MODULE: ModuleConfig = {
  href: "/activity",
  label: "Activity Log",
  gradient: "from-teal-500 to-teal-700",
  Icon: ActivityIcon,
  blurb: "Every live write this app has made to your connected Cin7 instances — Data Audit fixes/merges and sync pushes — with who triggered it and when.",
};

export const ADMIN_MODULE: ModuleConfig = {
  href: "/admin",
  label: "Admin",
  gradient: "from-fuchsia-500 to-fuchsia-700",
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
  gradient: "from-rose-500 to-rose-700",
  Icon: ShieldIcon,
  blurb: "Set up two-factor authentication with an authenticator app.",
};

export const MODULES: ModuleConfig[] = [
  IMPORT_MODULE,
  TEMPLATES_MODULE,
  MIGRATE_MODULE,
  REPORTS_MODULE,
  AUDIT_MODULE,
  HEALTH_MODULE,
  ASSEMBLIES_MODULE,
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
