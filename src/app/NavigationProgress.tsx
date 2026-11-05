"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { NAVIGATION_START_EVENT } from "./navigation-events";

// UX-007: immediate feedback for page transitions. The bar appears the instant an internal link is activated (or code announces a programmatic navigation),
// BEFORE the network responds, and goes away when the new location has rendered. It is indeterminate on purpose: it shows "navigating", never a percentage.
// A 15s ceiling removes it if the location never changes (a blocked or cancelled navigation), so it cannot stick on screen.

const GIVE_UP_MS = 15000;

function isPlainInternalLeftClick(e: MouseEvent, a: HTMLAnchorElement): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (a.target && a.target !== "_self") return false;
  if (a.hasAttribute("download")) return false;
  const url = new URL(a.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  // Same path + query (a hash jump or a no-op link) does not navigate.
  return url.pathname + url.search !== window.location.pathname + window.location.search;
}

function Bar() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const where = `${pathname}?${search}`;
  const whereRef = useRef(where);
  // The navigation is "in flight" while the location is still the one it started from; the moment the location changes it is over (derived, so no state is set on arrival).
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const active = startedAt !== null && startedAt === where;
  const timer = useRef<number | null>(null);
  useEffect(() => { whereRef.current = where; }, [where]);

  useEffect(() => {
    const stop = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; setStartedAt(null); };
    const start = () => { setStartedAt(whereRef.current); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(stop, GIVE_UP_MS); };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && isPlainInternalLeftClick(e, a)) start();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener(NAVIGATION_START_EVENT, start);
    window.addEventListener("popstate", start);
    return () => { document.removeEventListener("click", onClick, true); window.removeEventListener(NAVIGATION_START_EVENT, start); window.removeEventListener("popstate", start); if (timer.current) window.clearTimeout(timer.current); };
  }, []);

  if (!active) return <div role="status" aria-live="polite" className="sr-only" data-testid="navigation-progress" data-active="false" />;
  return (
    <div role="status" aria-live="polite" data-testid="navigation-progress" data-active="true" className="print:hidden">
      <div aria-hidden="true" className="nq-nav-bar fixed inset-x-0 top-0 z-[60] h-1 overflow-hidden bg-primary/20"><div className="nq-nav-bar-fill h-full w-1/3 bg-primary" /></div>
      <span className="sr-only">Loading the next page…</span>
    </div>
  );
}

/** Mount once in the root layout. */
export function NavigationProgress() {
  return <Suspense fallback={null}><Bar /></Suspense>;
}
