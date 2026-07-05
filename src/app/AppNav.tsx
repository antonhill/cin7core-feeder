"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";

type IconProps = { className?: string };

function ImportIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function TemplateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

function MigrateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m7 8-4 4 4 4M3 12h13.5M17 4l4 4-4 4M21 8H7.5" />
    </svg>
  );
}

function ReportsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 20V10m6 10V4m6 16v-7" />
    </svg>
  );
}

function InstancesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  );
}

function AdminIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3 4 6.5V11c0 4.5 3.2 8.7 8 10 4.8-1.3 8-5.5 8-10V6.5L12 3Z" />
    </svg>
  );
}

const LINKS = [
  { href: "/import", label: "Import & Sync", Icon: ImportIcon },
  { href: "/templates", label: "Templates", Icon: TemplateIcon },
  { href: "/migrate", label: "Migrate", Icon: MigrateIcon },
  { href: "/reports", label: "Reports", Icon: ReportsIcon },
  { href: "/settings/instances", label: "Cin7 Instances", Icon: InstancesIcon },
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
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-sm font-semibold text-white">
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

  const links = isSuperAdmin ? [...LINKS, { href: "/admin", label: "Admin", Icon: AdminIcon }] : LINKS;

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
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium transition-colors ${
                active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {link.label}
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
