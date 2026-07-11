"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";
import { MODULES, ADMIN_MODULE, BillingIcon, ShieldIcon, DiagnosticsIcon, SignOutIcon } from "@/app/module-nav";
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
    <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-2xl font-semibold text-white shadow-sm">
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
  showBilling,
}: {
  userEmail: string | null;
  isSuperAdmin: boolean;
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  disabledModules: string[];
  /** False while Lemon Squeezy's store isn't yet activated and this org has never subscribed — see checkoutAvailableFor in src/lib/billing.ts. */
  showBilling: boolean;
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
    <nav className="flex h-full w-64 shrink-0 flex-col bg-sidebar-bg print:hidden">
      <Link href="/" className="flex flex-col items-center gap-3 border-b border-sidebar-border px-5 py-6 text-lg font-bold text-sidebar-text-active">
        {orgLogoUrl ? (
          // Wide, not square — a real uploaded logo is often a wordmark, not
          // an icon, and a square box was cropping/shrinking it down to fit.
          // eslint-disable-next-line @next/next/no-img-element -- external, per-org logo URL; not worth configuring next/image remotePatterns for
          <img src={orgLogoUrl} alt={orgName ?? "Organization logo"} className="h-20 w-full shrink-0 rounded-2xl object-contain" />
        ) : (
          <OrgPlaceholder orgName={orgName} />
        )}
        <span className="max-w-full truncate text-center">{orgName ?? "Cin7 Core Toolbox"}</span>
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
              {/* Every module icon now carries its own color (see module-nav.tsx's SELF_COLORED_ICON_BADGE) — link.gradient is the same neutral value for all of them, which read as a stark white square against this sidebar's dark background (confirmed live 2026-07-11). bg-sidebar-bg-raised (already used for the active/hover state just below) gives the chip a background native to this dark palette instead. */}
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sidebar-bg-raised transition-transform ${
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
          <p className="truncate px-3 pb-3 text-sm text-sidebar-text">{userEmail}</p>
          {/* Compact icon-button row instead of stacked full-width text links — same active/hover treatment, just laid out horizontally to reclaim vertical space at the bottom of the sidebar. */}
          <div className="flex items-center justify-center gap-2">
            {showBilling && (
              <Link
                href="/settings/billing"
                title="Billing"
                aria-label="Billing"
                className={`flex h-10 w-10 items-center justify-center rounded-lg border transition ${
                  pathname.startsWith("/settings/billing")
                    ? "border-sidebar-bg-raised bg-sidebar-bg-raised"
                    : "border-sidebar-border hover:bg-sidebar-bg-raised"
                }`}
              >
                <BillingIcon className="h-5 w-5" />
              </Link>
            )}
            <Link
              href="/settings/security"
              title="Security"
              aria-label="Security"
              className={`flex h-10 w-10 items-center justify-center rounded-lg border transition ${
                pathname.startsWith("/settings/security")
                  ? "border-sidebar-bg-raised bg-sidebar-bg-raised"
                  : "border-sidebar-border hover:bg-sidebar-bg-raised"
              }`}
            >
              <ShieldIcon className="h-5 w-5" />
            </Link>
            {isSuperAdmin && (
              <Link
                href="/settings/diagnostics"
                title="Diagnostics"
                aria-label="Diagnostics"
                className={`flex h-10 w-10 items-center justify-center rounded-lg border transition ${
                  pathname.startsWith("/settings/diagnostics")
                    ? "border-sidebar-bg-raised bg-sidebar-bg-raised"
                    : "border-sidebar-border hover:bg-sidebar-bg-raised"
                }`}
              >
                <DiagnosticsIcon className="h-5 w-5" />
              </Link>
            )}
            <form action={signOutAction}>
              <button
                type="submit"
                title="Sign out"
                aria-label="Sign out"
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-sidebar-border transition hover:bg-sidebar-bg-raised"
              >
                <SignOutIcon className="h-5 w-5" />
              </button>
            </form>
          </div>
          <Link href="/privacy" className="mt-3 block text-center text-xs text-sidebar-text/70 hover:text-sidebar-text-active hover:underline">
            Privacy Policy
          </Link>
        </div>
      )}
    </nav>
  );
}
