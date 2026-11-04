"use client";

import { useState } from "react";
import type { DemoBarState } from "@/lib/demo-mode/context";
import { exitDemoModeAction, selectDemoIdentityAction } from "./demo-mode/actions";

// The Demo Mode selector and the always-visible banner. Switching reloads the whole page so no data fetched for one identity can remain on screen under another.
const OPTIONS = [["owner", "Owner (you)"], ["rep", "Rep"], ["estimator", "Estimator"], ["manager", "Manager"]] as const;

export function DemoModeControls({ state }: { state: DemoBarState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setError(null);
    const r = await fn();
    if (!r.ok) { setBusy(false); setError(r.error ?? "Could not switch."); return; }
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
              return <button key={v} type="button" aria-pressed={on} disabled={busy} onClick={() => go(() => selectDemoIdentityAction(v))} className={`rounded-full px-3 py-0.5 text-xs font-semibold ${on ? "bg-white text-slate-900" : "border border-white/70 hover:bg-white/10"}`}>{l}</button>;
            })}
          </span>
        )}
        {active && <button type="button" disabled={busy} onClick={() => go(exitDemoModeAction)} className="rounded-full border border-white/70 px-3 py-0.5 text-xs font-semibold hover:bg-white/10">Exit Demo Mode</button>}
        {error && <span className="text-xs text-yellow-200">{error}</span>}
      </span>
    </div>
  );
}
