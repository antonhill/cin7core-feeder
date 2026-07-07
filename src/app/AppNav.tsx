"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";
import { MODULES, ADMIN_MODULE } from "@/app/module-nav";
import { OrgSwitcher } from "@/app/OrgSwitcher";

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
  orgId,
  orgName,
  orgLogoUrl,
  disabledModules,
}: {
  userEmail: string | null;
  isSuperAdmin: boolean;
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  disabledModules: string[];
}) {
  const pathname = usePathname();

  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/mfa-challenge") ||
    pathname.startsWith("/privacy")
  )
    return null;

  // Admin isn't an org-toggleable module — it's a cross-org super-admin tool, not something a client org's own visibility settings apply to.
  const visibleModules = MODULES.filter((m) => !disabledModules.includes(m.href));
  const links = isSuperAdmin ? [...visibleModules, ADMIN_MODULE] : visibleModules;

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col bg-sidebar-bg">
      <Link href="/" className="flex items-center gap-3 whitespace-nowrap border-b border-sidebar-border px-5 py-6 text-lg font-bold text-sidebar-text-active">
        {orgLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external, per-org logo URL; not worth configuring next/image remotePatterns for
          <img src={orgLogoUrl} alt={orgName ?? "Organization logo"} className="h-10 w-10 shrink-0 rounded-lg object-contain" />
        ) : (
          <OrgPlaceholder orgName={orgName} />
        )}
        <span className="truncate">{orgName ?? "Cin7 Core Toolbox"}</span>
      </Link>

      {isSuperAdmin && <OrgSwitcher currentOrgId={orgId} />}

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
        {links.map((link) => {
          const active = pathname.startsWith(link.href);
          const Icon = link.Icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`group flex items-center gap-3 rounded-xl px-2.5 py-2 text-base font-medium transition-all ${
                active ? "bg-sidebar-bg-raised text-sidebar-text-active shadow-sm" : "text-sidebar-text hover:bg-sidebar-bg-raised/60 hover:text-sidebar-text-active"
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
        <div className="border-t border-sidebar-border px-3 py-4">
          <p className="truncate px-3 pb-2 text-sm text-sidebar-text">{userEmail}</p>
          <Link
            href="/settings/security"
            className={`mb-2 block rounded-lg border px-3 py-2 text-center text-sm font-medium transition ${
              pathname.startsWith("/settings/security")
                ? "border-sidebar-bg-raised bg-sidebar-bg-raised text-sidebar-text-active"
                : "border-sidebar-border text-sidebar-text hover:bg-sidebar-bg-raised hover:text-sidebar-text-active"
            }`}
          >
            Security
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full rounded-lg border border-sidebar-border px-3 py-2 text-sm font-medium text-sidebar-text hover:bg-sidebar-bg-raised hover:text-sidebar-text-active"
            >
              Sign out
            </button>
          </form>
          <Link href="/privacy" className="mt-3 block text-center text-xs text-sidebar-text/70 hover:text-sidebar-text-active hover:underline">
            Privacy Policy
          </Link>
        </div>
      )}
    </nav>
  );
}
