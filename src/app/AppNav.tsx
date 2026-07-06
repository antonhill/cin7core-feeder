"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";
import { MODULES, ADMIN_MODULE } from "@/app/module-nav";

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

  const links = isSuperAdmin ? [...MODULES, ADMIN_MODULE] : MODULES;

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
