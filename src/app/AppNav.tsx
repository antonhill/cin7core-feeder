"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";

const LINKS = [
  { href: "/import", label: "Import & Sync" },
  { href: "/templates", label: "Templates" },
  { href: "/migrate", label: "Migrate" },
  { href: "/settings/instances", label: "Cin7 Instances" },
];

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

  const links = isSuperAdmin ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS;

  return (
    <nav className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-3 whitespace-nowrap text-lg font-bold text-slate-900">
          {orgLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external, per-org logo URL; not worth configuring next/image remotePatterns for
            <img src={orgLogoUrl} alt={orgName ?? "Organization logo"} className="h-11 w-auto max-w-[160px] object-contain" />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-sm text-white">
              C7
            </span>
          )}
          {orgName ?? "Cin7 Feeder"}
        </Link>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {links.map((link) => {
            const active = pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-base font-medium transition-colors ${
                  active ? "bg-indigo-50 text-indigo-700" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
        {userEmail && (
          <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-sm text-slate-500">
            <span>{userEmail}</span>
            <form action={signOutAction}>
              <button type="submit" className="rounded-full border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </nav>
  );
}
