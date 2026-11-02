"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/actions/auth";
import { isNavLinkActive, type ModuleConfig } from "@/app/module-nav";

/**
 * The dedicated NewQuip workspace chrome: one compact header in place of the Toolbox sidebar, shown on the NewQuip routes only (Solution Builder, Projects,
 * Approvals and everything under them). It is presentation, not access control: the routes' layouts and every server action still authorise the NewQuip
 * organisation independently, and no URL changes. It makes no network request and holds no state, so moving between NewQuip pages keeps it mounted.
 */
export function NewquipShell({
  links,
  orgName,
  userEmail,
  children,
}: {
  links: ModuleConfig[];
  orgName: string | null;
  userEmail: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="newquip-workspace">
      <a
        href="#newquip-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-slate-900 focus:shadow-md"
      >
        Skip to content
      </a>
      <header className="z-20 shrink-0 border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex w-full max-w-[1920px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 md:px-6">
          <Link
            href="/"
            className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 md:min-h-9"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
              <path d="M15 6l-6 6 6 6" />
            </svg>
            Back to Toolbox
          </Link>
          <span aria-hidden className="hidden h-5 w-px bg-slate-200 md:block" />
          <span className="hidden text-sm font-semibold tracking-tight text-slate-900 md:inline">NewQuip</span>
          <nav aria-label="NewQuip" className="order-last -mx-2 flex w-full items-center gap-1 overflow-x-auto md:order-none md:mx-0 md:w-auto">
            {links.map((l) => {
              const active = isNavLinkActive(pathname, l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm md:min-h-9 ${
                    active ? "bg-primary-subtle font-semibold text-indigo-900" : "font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            {orgName && <span className="max-w-[16rem] truncate text-sm text-slate-700" title={orgName}>{orgName}</span>}
            {userEmail && <span className="hidden max-w-[16rem] truncate text-sm text-slate-600 xl:inline" title={userEmail}>{userEmail}</span>}
            <form action={signOutAction}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 md:min-h-9"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <div id="newquip-content" className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}
