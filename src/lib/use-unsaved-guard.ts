"use client";

import { useEffect } from "react";

export const UNSAVED_MESSAGE = "You have unsaved changes. If you leave now they will be lost.";

/**
 * Warns before the user loses meaningful unsaved input. The guard exists ONLY while `dirty` is true: when it turns false (saved, cancelled, reset) or the component
 * unmounts, every listener is removed, so read-only pages and finished workflows are never interrupted.
 *
 * Covers: closing or reloading the tab and following an address-bar/back-forward unload (`beforeunload`, which browsers show as their own generic prompt), and a
 * plain click on an in-app link (the App Router has no navigation-blocking API, so a capture-phase click listener asks first). It does NOT cover the browser Back
 * button within the app or programmatic router.push calls, which cannot be intercepted reliably in the App Router.
 */
export function useUnsavedGuard(dirty: boolean, message: string = UNSAVED_MESSAGE): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // legacy browsers need a value to show the prompt
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a || (a.getAttribute("target") && a.getAttribute("target") !== "_self") || a.hasAttribute("download")) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
      let url: URL;
      try { url = new URL(href, window.location.href); } catch { return; }
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) return; // same page
      if (!window.confirm(message)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}
