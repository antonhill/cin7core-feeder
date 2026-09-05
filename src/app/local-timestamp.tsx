"use client";

import { useSyncExternalStore } from "react";

/**
 * Renders an instant in the VIEWER's locale and timezone.
 *
 * The dashboard is a Server Component, so anything it formats inline is
 * formatted with the *server's* locale and timezone — on Vercel, UTC. A sync
 * that happened at 16:30 SAST was rendering as "9/5/2026, 2:30:00 PM": two
 * hours early, in a format the reader didn't choose. The same timestamp on
 * /reports/stock-health was already correct, because that page is a Client
 * Component and formats in the browser. This makes the dashboard agree with it.
 *
 * A Client Component is still server-rendered for the initial HTML, so
 * formatting during render would put the server's rendering in that HTML and
 * the viewer's in the hydrated tree — a text mismatch. `suppressHydrationWarning`
 * is the usual reflex and is the wrong tool here: it silences the warning
 * without re-rendering, so the server's (wrong) value would simply persist.
 *
 * `useSyncExternalStore` is the sanctioned way to render deliberately different
 * markup on server and client: React uses the server snapshot for both the SSR
 * pass and the hydration pass — so they agree — then re-renders with the client
 * snapshot. The only formatted value ever shown is the viewer's own, and no
 * incorrect instant is displayed even for a frame. `dateTime` carries the exact
 * ISO instant throughout, for machines and assistive technology.
 */
const subscribe = () => () => {};
const isHydrated = () => false;
const isServerRender = () => true;

export default function LocalTimestamp({ iso }: { iso: string }) {
  const serverRendering = useSyncExternalStore(subscribe, isHydrated, isServerRender);

  return <time dateTime={iso}>{serverRendering ? "—" : new Date(iso).toLocaleString()}</time>;
}
