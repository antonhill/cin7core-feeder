"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";

type IconProps = { className?: string };

function ImportIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function TemplateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

function MigrateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m7 8-4 4 4 4M3 12h13.5M17 4l4 4-4 4M21 8H7.5" />
    </svg>
  );
}

function ReportsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 20V10m6 10V4m6 16v-7" />
    </svg>
  );
}

function InstancesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  );
}

function AuditIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 11.5 11 13.5 15.5 9M12 3l7 3v6c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V6l7-3Z" />
    </svg>
  );
}

function HealthIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  );
}

function AdminIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="9" r="2.5" />
      <path d="M12 3a9 9 0 0 0-9 9c0 3 1.6 4.8 3.5 6M12 3a9 9 0 0 1 9 9c0 3-1.6 4.8-3.5 6M8 21c.7-2.3 2.2-3.5 4-3.5s3.3 1.2 4 3.5" />
    </svg>
  );
}

/**
 * Each item carries its own gradient chip color, purely for visual variety/
 * personality (Anton: "funky modern graphics... more professional") — the
 * color has no semantic meaning beyond "this section has a distinct identity."
 * Kept to Tailwind's built-in gradient utilities (no arbitrary/inline
 * gradients) so the class list stays statically analyzable by the Tailwind
 * compiler.
 */
const LINKS = [
  { href: "/import", label: "Import & Sync", Icon: ImportIcon, gradient: "from-indigo-500 to-indigo-700" },
  { href: "/templates", label: "Templates", Icon: TemplateIcon, gradient: "from-violet-500 to-violet-700" },
  { href: "/migrate", label: "Migrate", Icon: MigrateIcon, gradient: "from-cyan-500 to-cyan-700" },
  { href: "/reports", label: "Reports", Icon: ReportsIcon, gradient: "from-amber-500 to-amber-600" },
  { href: "/audit", label: "Data Audit", Icon: AuditIcon, gradient: "from-rose-500 to-rose-700" },
  { href: "/health", label: "System Health", Icon: HealthIcon, gradient: "from-emerald-500 to-emerald-700" },
  { href: "/settings/instances", label: "Cin7 Instances", Icon: InstancesIcon, gradient: "from-slate-500 to-slate-700" },
];

/** Two-letter fallback avatar shown when an org has no logo uploaded yet. */
function OrgPlaceholder({ orgName }: { orgName: string | null }) {
  const initials = (orgName ?? "C7")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("") || "C7";

  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 text-sm font-semibold text-white shadow-sm">
      {initials}
    </span>
  );
}

export function AppNav({
  userEmail,
  isSuperAdmin,
  orgName,
  orgLogoUrl,
}: {
  userEmail: string | null;
  isSuperAdmin: boolean;
  orgName: string | null;
  orgLogoUrl: string | null;
}) {
  const pathname = usePathname();

  if (pathname.startsWith("/login") || pathname.startsWith("/auth")) return null;

  const links = isSuperAdmin
    ? [...LINKS, { href: "/admin", label: "Admin", Icon: AdminIcon, gradient: "from-fuchsia-500 to-fuchsia-700" }]
    : LINKS;

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <Link href="/" className="flex items-center gap-3 whitespace-nowrap px-5 py-6 text-lg font-bold text-slate-900">
        {orgLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external, per-org logo URL; not worth configuring next/image remotePatterns for
          <img src={orgLogoUrl} alt={orgName ?? "Organization logo"} className="h-10 w-10 shrink-0 rounded-lg object-contain" />
        ) : (
          <OrgPlaceholder orgName={orgName} />
        )}
        <span className="truncate">{orgName ?? "Cin7 Core Toolbox"}</span>
      </Link>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3">
        {links.map((link) => {
          const active = pathname.startsWith(link.href);
          const Icon = link.Icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`group flex items-center gap-3 rounded-xl px-2.5 py-2 text-base font-medium transition-all ${
                active ? "bg-white text-slate-900 shadow-md ring-1 ring-slate-200" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white transition-transform ${link.gradient} ${
                  active ? "shadow-sm" : "opacity-90 group-hover:scale-105 group-hover:opacity-100"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
              </span>
              <span className={active ? "font-semibold" : ""}>{link.label}</span>
            </Link>
          );
        })}
      </div>

      {userEmail && (
        <div className="border-t border-slate-200 px-3 py-4">
          <p className="truncate px-3 pb-2 text-sm text-slate-500">{userEmail}</p>
          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </nav>
  );
}
