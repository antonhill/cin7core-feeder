"use client";

import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AppNav, isNavHiddenPath, type AppNavProps } from "./AppNav";

/**
 * Owns the one piece of state a responsive shell needs that AppNav can't own
 * itself: whether the mobile drawer is open. AppNav stays a normal in-flow
 * sidebar at md+ (compact icon rail) and lg+ (full width) — this only
 * matters below md, where AppNav renders off-canvas and this component
 * supplies the trigger, the backdrop, and focus return.
 */
export function AppShell({ nav, children }: { nav: AppNavProps; children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  function closeMobileNav() {
    setMobileOpen(false);
    // Return focus to the control that opened the drawer — losing focus to
    // <body> on close is disorienting for keyboard/screen-reader users.
    triggerRef.current?.focus();
  }

  // AppNav itself renders nothing on these paths (pre-auth / step-up flows
  // with their own full-page layout) — matching here means the mobile top
  // bar and backdrop never appear with no drawer behind them to open.
  if (isNavHiddenPath(pathname)) return <>{children}</>;

  return (
    <>
      {/* Mobile-only top bar: the sole way to reach navigation below md, since AppNav itself is off-canvas there until opened. */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden print:hidden">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          aria-label="Open navigation"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <span className="truncate text-sm font-semibold text-slate-900">{nav.orgName ?? "Cin7 Core Toolbox"}</span>
      </div>

      {/* Backdrop — mobile only, only rendered while the drawer is open; clicking it closes the drawer same as the drawer's own close button. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/50 md:hidden"
          onClick={closeMobileNav}
          aria-hidden
        />
      )}

      <AppNav {...nav} mobileOpen={mobileOpen} onRequestClose={closeMobileNav} />

      {children}
    </>
  );
}
