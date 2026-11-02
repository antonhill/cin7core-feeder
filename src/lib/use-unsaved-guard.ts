"use client";

import { useEffect } from "react";

export const UNSAVED_MESSAGE = "You have unsaved changes. If you leave now they will be lost.";

/**
 * Warns before the user loses meaningful unsaved input. The guard exists ONLY while `dirty` is true: when it turns false (saved, cancelled, reset) or the component
 * unmounts, every listener is removed, so read-only pages and finished workflows are never interrupted.
 *
 * Covers (see docs/newquip-unsaved-work-protection.md for the browser evidence):
 *  - closing/reloading the tab or typing another address (`beforeunload`, the browser's own generic prompt);
 *  - a plain click on an in-app link (capture-phase click listener + window.confirm; a declined click never reaches the router, so history and the screen stay intact);
 *  - the browser Back/Forward button, ONLY where the Navigation API exists (Chromium): a same-document `traverse` navigate event is cancelled when declined. Cancelling
 *    is done for `traverse` ONLY. Cancelling `push`/`replace` navigate events is deliberately NOT done: the browser keeps the old URL but the App Router has already
 *    rendered the new page, leaving the URL and screen out of step (demonstrated in a real browser). The browser itself limits a page to one cancelled Back per user
 *    gesture, so a second Back press leaves unprompted: it can never trap the user. Browsers without the API simply do not get this layer (never a history hack).
 * It does NOT cover programmatic router.push/replace (no safe hook exists in the App Router).
 */
export function useUnsavedGuard(dirty: boolean, message: string = UNSAVED_MESSAGE): void {
  useEffect(() => {
    if (!dirty) return;
    const entry = { message };
    acquire(entry);
    return () => release(entry);
  }, [dirty, message]);
}

// One shared pair of listeners for the whole page, however many guards are dirty: any active guard prompts once, never once per guard.
const active = new Set<{ message: string }>();

function onBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = ""; // legacy browsers need a value to show the prompt
}

function onClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!a || (a.getAttribute("target") && a.getAttribute("target") !== "_self") || a.hasAttribute("download")) return;
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
  let url: URL;
  try { url = new URL(href, window.location.href); } catch { return; }
  if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) return; // same page
  const [first] = active;
  if (first && !window.confirm(first.message)) { e.preventDefault(); e.stopPropagation(); }
}

// Minimal structural typing of the part of the Navigation API we use (not in every TypeScript DOM lib).
interface NavigateEventLike { navigationType: string; cancelable: boolean; hashChange: boolean; preventDefault(): void }
interface NavigationLike { addEventListener(t: "navigate", l: (e: NavigateEventLike) => void): void; removeEventListener(t: "navigate", l: (e: NavigateEventLike) => void): void }
const navigationApi = (): NavigationLike | null => (typeof window !== "undefined" && (window as unknown as { navigation?: NavigationLike }).navigation) || null;

/** Back/Forward: ask, and cancel the traversal if declined. Only `traverse`, only when the browser says it may be cancelled; everything else is left to the other layers. */
function onNavigate(e: NavigateEventLike) {
  if (e.navigationType !== "traverse" || !e.cancelable || e.hashChange) return;
  const [first] = active;
  if (first && !window.confirm(first.message)) e.preventDefault();
}

function acquire(entry: { message: string }) {
  if (active.size === 0) {
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    navigationApi()?.addEventListener("navigate", onNavigate);
  }
  active.add(entry);
}

function release(entry: { message: string }) {
  active.delete(entry);
  if (active.size === 0) {
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.removeEventListener("click", onClick, true);
    navigationApi()?.removeEventListener("navigate", onNavigate);
  }
}
