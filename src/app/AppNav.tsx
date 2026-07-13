"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";
import { uploadCurrentOrgLogo } from "@/actions/org-logo";
import { triggerSalesSyncAction } from "@/app/reports/actions";
import { MODULES, ADMIN_MODULE, BillingIcon, ShieldIcon, DiagnosticsIcon, TeamIcon, SyncIcon, SignOutIcon } from "@/app/module-nav";
import { OrgSwitcher } from "@/app/OrgSwitcher";
import { Spinner } from "@/app/Spinner";

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

/** Icon-only nav button (Link, plain submit button, or an async onClick action) with a small custom tooltip on hover — the native `title` attribute alone has a slow, easy-to-miss browser tooltip, so this pairs a fast styled one with it while keeping `title`/`aria-label` for accessibility. Tooltip opens upward since these buttons sit at the very bottom of the sidebar. */
function NavIconButton({
  href,
  label,
  active,
  onClick,
  busy,
  children,
}: {
  href?: string;
  label: string;
  active?: boolean;
  /** Client-driven async action (e.g. triggering a sync) — mutually exclusive with `href`. */
  onClick?: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const className = `group relative flex h-10 w-10 items-center justify-center rounded-lg border transition ${
    active ? "border-sidebar-bg-raised bg-sidebar-bg-raised" : "border-sidebar-border hover:bg-sidebar-bg-raised"
  } ${busy ? "opacity-60" : ""}`;
  const tooltip = (
    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
      {label}
    </span>
  );

  if (href) {
    return (
      <Link href={href} title={label} aria-label={label} className={className}>
        {children}
        {tooltip}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={busy} title={label} aria-label={label} className={className}>
        {busy ? <Spinner /> : children}
        {tooltip}
      </button>
    );
  }
  return (
    <button type="submit" title={label} aria-label={label} className={className}>
      {children}
      {tooltip}
    </button>
  );
}

export function AppNav({
  userEmail,
  isSuperAdmin,
  isOrgAdmin,
  orgId,
  orgName,
  orgLogoUrl,
  disabledModules,
  showBilling,
}: {
  userEmail: string | null;
  isSuperAdmin: boolean;
  /** True for a super-admin, or an org_members row with role 'owner'/'admin' — shows the Team settings icon. */
  isOrgAdmin: boolean;
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  disabledModules: string[];
  /** False while Lemon Squeezy's store isn't yet activated and this org has never subscribed — see checkoutAvailableFor in src/lib/billing.ts. */
  showBilling: boolean;
}) {
  const pathname = usePathname();
  // Real bug found 2026-07-11: this state's initial value only applies on
  // mount — if AppNav itself doesn't remount, switching orgs (e.g. the
  // super-admin org switcher) left the sidebar showing the PREVIOUS org's
  // logo, since orgLogoUrl updating as a prop doesn't reach state already
  // initialized from it. Layout.tsx now remounts this whole component on an
  // org switch (`key={orgId}`) specifically so this initializer re-runs with
  // the new org's real logo — don't "fix" that by syncing via a useEffect
  // instead (React's own lint rule here flags setState-in-effect as the
  // wrong tool for this; a key-based remount is the correct pattern for
  // "reset state when this identity changes").
  const [logoUrl, setLogoUrl] = useState(orgLogoUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [isUploadingLogo, startLogoTransition] = useTransition();

  // Available regardless of which page is open (not just the Sales report)
  // — every report that reads sale_lines/sales (the Natas report especially)
  // is only as fresh as the last sync, so this is a global shortcut for the
  // same triggerSalesSyncAction the Sales report page's own button already
  // calls, not a separate sync mechanism.
  const [syncMessage, setSyncMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();

  function handleGlobalSync() {
    setSyncMessage(null);
    startSyncTransition(async () => {
      const result = await triggerSalesSyncAction();
      if (!result.ok) {
        setSyncMessage({ ok: false, text: result.error ?? "Sync failed" });
        return;
      }
      const totalSynced = (result.data ?? []).reduce((sum, s) => sum + s.detailSynced, 0);
      setSyncMessage({ ok: true, text: totalSynced > 0 ? `Synced ${totalSynced} sale${totalSynced === 1 ? "" : "s"}` : "Already up to date" });
    });
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoError(null);
    const formData = new FormData();
    formData.set("logo", file);
    startLogoTransition(async () => {
      const result = await uploadCurrentOrgLogo(formData);
      if (!result.ok) {
        setLogoError(result.error ?? "Unknown error");
        return;
      }
      setLogoUrl(result.logoUrl ?? null);
    });
  }

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
      <div className="flex flex-col items-center gap-3 border-b border-sidebar-border px-5 py-6">
        {/* Hover-to-change logo upload — any org member can set their own org's logo now (was previously an /admin-only super-admin action; see src/lib/org-logo.ts for the shared upload logic both now call). */}
        <label className="group relative flex h-20 w-full cursor-pointer items-center justify-center overflow-hidden rounded-2xl">
          {logoUrl ? (
            // Wide, not square — a real uploaded logo is often a wordmark, not
            // an icon, and a square box was cropping/shrinking it down to fit.
            // eslint-disable-next-line @next/next/no-img-element -- external, per-org logo URL; not worth configuring next/image remotePatterns for
            <img src={logoUrl} alt={orgName ?? "Organization logo"} className="h-20 w-full shrink-0 rounded-2xl object-contain" />
          ) : (
            <OrgPlaceholder orgName={orgName} />
          )}
          <span className="absolute inset-0 flex items-center justify-center rounded-2xl bg-slate-900/70 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
            {isUploadingLogo && <Spinner className="mr-1.5" />}
            {isUploadingLogo ? "Uploading…" : "Change logo"}
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={handleLogoChange}
            disabled={isUploadingLogo}
            className="hidden"
          />
        </label>
        <Link href="/" className="max-w-full truncate text-center text-lg font-bold text-sidebar-text-active hover:underline">
          {orgName ?? "Cin7 Core Toolbox"}
        </Link>
        {logoError && <p className="max-w-full text-center text-xs text-red-400">{logoError}</p>}
      </div>

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
          {/* flex-wrap: up to 6 icons can appear at once now (Sync + Billing + Security + Team + Diagnostics + Sign out for a super-admin/org-admin with billing enabled) — 6 * 40px buttons + gaps exceeds the sidebar's available width, so this wraps to a second row instead of overflowing. */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <NavIconButton label="Sync sales" onClick={handleGlobalSync} busy={isSyncing}>
              <SyncIcon className="h-5 w-5" />
            </NavIconButton>
            {showBilling && (
              <NavIconButton href="/settings/billing" label="Billing" active={pathname.startsWith("/settings/billing")}>
                <BillingIcon className="h-5 w-5" />
              </NavIconButton>
            )}
            <NavIconButton href="/settings/security" label="Security" active={pathname.startsWith("/settings/security")}>
              <ShieldIcon className="h-5 w-5" />
            </NavIconButton>
            {isOrgAdmin && (
              <NavIconButton href="/settings/members" label="Team" active={pathname.startsWith("/settings/members")}>
                <TeamIcon className="h-5 w-5" />
              </NavIconButton>
            )}
            {isSuperAdmin && (
              <NavIconButton href="/settings/diagnostics" label="Diagnostics" active={pathname.startsWith("/settings/diagnostics")}>
                <DiagnosticsIcon className="h-5 w-5" />
              </NavIconButton>
            )}
            <form action={signOutAction}>
              <NavIconButton label="Sign out">
                <SignOutIcon className="h-5 w-5" />
              </NavIconButton>
            </form>
          </div>
          {syncMessage && (
            <p className={`mt-2 text-center text-xs ${syncMessage.ok ? "text-sidebar-text/70" : "text-red-400"}`}>{syncMessage.text}</p>
          )}
          <Link href="/privacy" className="mt-3 block text-center text-xs text-sidebar-text/70 hover:text-sidebar-text-active hover:underline">
            Privacy Policy
          </Link>
        </div>
      )}
    </nav>
  );
}
