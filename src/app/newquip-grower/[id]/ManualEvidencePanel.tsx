"use client";

import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { formatSast } from "@/lib/approvals/time";
import type { ManualEvidenceRow } from "@/newquip/pricing/estimator";

// NQ-008B P2-E. What a Manager sees at approval about the items the Estimator priced by hand with NO SKU behind them (M75, LED lighting, penning, any manual item): the evidence
// note, who recorded it and when, and whether it still covers the current price. Read-only, labels and text only (never a price). Rendered ONLY for cost-entitled viewers: the server
// puts these rows in the quote view for them alone, so a Rep's payload never carries the text.

export function ManualEvidencePanel({ rows }: { rows: readonly ManualEvidenceRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Panel className="mt-3"><div data-testid="manual-evidence-summary">
      <PanelTitle>Pricing evidence for manual items</PanelTitle>
      <p className="mt-1 text-xs text-slate-700">Items priced by the Estimator with no SKU behind them. A recorded note is required before final approval.</p>
      <ul className="mt-2 space-y-2">
        {rows.map((r) => (
          <li key={r.itemKey} className="rounded-md border border-slate-200 p-2 text-sm" data-testid="manual-evidence-row" data-state={r.state}>
            <div className="flex flex-wrap items-baseline gap-2"><b>{r.label}</b><Status tone={r.state === "recorded" ? "success" : "warning"}>{r.state === "recorded" ? "Evidence recorded" : r.state === "outdated" ? "Price changed since" : "No evidence"}</Status></div>
            {r.note ? <p className="mt-1 text-slate-800">{r.note}{r.reference ? ` (ref ${r.reference})` : ""}<span className="text-xs text-slate-700"> — recorded by {r.by}{r.at ? `, ${formatSast(r.at)}` : ""}</span></p> : null}
            {r.state !== "recorded" && <p className="mt-1 text-xs text-slate-900">{r.stateText}.</p>}
          </li>
        ))}
      </ul>
    </div></Panel>
  );
}
