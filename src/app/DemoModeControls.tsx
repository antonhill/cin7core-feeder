"use client";

import { useRef, useState } from "react";
import type { DemoBarState } from "@/lib/demo-mode/context";
import { exitDemoModeAction, selectDemoIdentityAction } from "./demo-mode/actions";
import { Spinner } from "./Spinner";
import { announceNavigation } from "./navigation-events";
import { SLOW_AFTER_MS, switchingTo } from "@/components/ui/operation-labels";
import { useElapsedSeconds } from "@/components/ui/use-elapsed";

// The Demo Mode selector and the always-visible banner. Switching reloads the whole page so no data fetched for one identity can remain on screen under another.
const OPTIONS = [["owner", "Owner (you)"], ["rep", "Rep"], ["estimator", "Estimator"], ["manager", "Manager"]] as const;

export function DemoModeControls({ state }: { state: DemoBarState }) {
  const [busy, setBusy] = useState(false);
  const switching = useRef(false); // a ref, not state: a same-tick double click must not start two switches
  const [what, setWhat] = useState<string | null>(null); // UX-007: the switch in flight, named ("Switching to Estimator…")
  const [error, setError] = useState<string | null>(null);
  const waited = useElapsedSeconds(busy, what ?? ""); // UX-007: real seconds waited, shown only once it is slow
  const go = async (fn: () => Promise<{ ok: boolean; error?: string }>, label: string) => {
    if (switching.current) return; // a double-click cannot start a second switch
    switching.current = true;
    setBusy(true); setWhat(label); setError(null);
    let r: { ok: boolean; error?: string };
    try { r = await fn(); } catch { switching.current = false; setBusy(false); setWhat(null); setError("The switch did not complete and nothing was changed. You can try again."); return; }
    if (!r.ok) { switching.current = false; setBusy(false); setWhat(null); setError(r.error ?? "Could not switch."); return; }
    announceNavigation(); // the page reloads next: the busy state and the navigation bar stay up until it does
    // Stay on the page being presented: reload THIS path (never another quotation, never a remembered or configured one). The query (?stage / ?step) is dropped so the page opens at the first
    // step the newly selected role may act on, and replace() adds no history entry, so Back and Forward keep working on the same quotation.
    window.location.replace(window.location.pathname);
  };
  const active = state.active;
  return (
    <div role="region" aria-label="Demo Mode" className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm font-semibold print:hidden ${active ? "bg-indigo-700 text-white" : "bg-slate-800 text-white"}`}>
      <span>
        {active
          ? `Presenting as ${active.label} · UAT demonstration, every action is audited`
          : "UAT demonstration · choose a role to present"}
      </span>
      <span className="flex items-center gap-2">
        {state.selectable && (
          <span role="group" aria-label="Demo identity" className="flex items-center gap-1">
            {OPTIONS.map(([v, l]) => {
              const on = (active?.slot ?? "owner") === v;
              return <button key={v} type="button" aria-pressed={on} disabled={busy} onClick={() => go(() => selectDemoIdentityAction(v), switchingTo(l.replace(" (you)", "")))} className={`rounded-full px-3 py-0.5 text-xs font-semibold ${on ? "bg-white text-slate-900" : "border border-white/70 hover:bg-white/10"}`}>{l}</button>;
            })}
          </span>
        )}
        {active && <button type="button" disabled={busy} onClick={() => go(exitDemoModeAction, "Leaving Demo Mode…")} className="rounded-full border border-white/70 px-3 py-0.5 text-xs font-semibold hover:bg-white/10">Exit Demo Mode</button>}
        <span role="status" aria-live="polite" data-testid="demo-switch-status" className="flex items-center gap-1.5 text-xs">{what && <><Spinner />{what}{waited * 1000 >= SLOW_AFTER_MS && <span data-testid="demo-switch-slow"> · still waiting ({waited}s), please do not click again</span>}</>}</span>
        {error && <span role="alert" className="text-xs text-yellow-200">{error}</span>}
      </span>
    </div>
  );
}
