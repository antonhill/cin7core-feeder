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
    window.location.reload();
  };
  const active = state.active;
  return (
    <div role="region" aria-label="Demo Mode" className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm font-semibold print:hidden ${active ? "bg-red-700 text-white" : "bg-slate-800 text-white"}`}>
      <span>
        {active
          ? `DEMO MODE - acting as ${active.label} (${active.email}). Actions are recorded as impersonated by the owner. Expires ${new Date(active.expiresAt).toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit" })} SAST.`
          : "Demo Mode (Preview, owner only) - you are acting as yourself."}
      </span>
      <span className="flex items-center gap-2">
        {state.selectable && (
          <label className="flex items-center gap-1 text-xs font-medium">
            Act as
            <select aria-label="Demo identity" disabled={busy} value={active?.slot ?? "owner"} onChange={(e) => go(() => selectDemoIdentityAction(e.target.value))} className="rounded bg-white px-2 py-0.5 text-slate-900">
              {OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        {active && <button type="button" disabled={busy} onClick={() => go(exitDemoModeAction)} className="rounded-full border border-white/70 px-3 py-0.5 text-xs font-semibold hover:bg-white/10">Exit Demo Mode</button>}
        {error && <span className="text-xs text-yellow-200">{error}</span>}
      </span>
    </div>
  );
}
