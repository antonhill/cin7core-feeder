"use client";

import { useEffect, useState } from "react";
import type { NextAction } from "@/newquip/pricing/estimator";

// The ONE prominent "what do I do next" banner of the Cost & Verify step for a quotation that uses Phase 2 supplier pricing. It renders a NextAction that a pure function derived from data the page
// already holds (nextCostVerifyAction); it has no controls and decides nothing.

const TONE: Record<NextAction["tone"], string> = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-950",
  warning: "border-amber-400 bg-amber-50 text-amber-950",
  info: "border-indigo-300 bg-indigo-50 text-indigo-950",
  danger: "border-red-300 bg-red-50 text-red-950",
};

export function CostVerifyBanner({ action }: { action: NextAction }) {
  return (
    <section role="status" aria-label="Next action" className={`rounded-lg border-2 p-4 ${TONE[action.tone]}`} data-testid="cost-next-action" data-next-action={action.id}>
      <p className="text-xs font-semibold uppercase tracking-wide">Next action</p>
      <h3 className="mt-0.5 text-lg font-semibold" data-testid="cost-next-action-headline">{action.headline}</h3>
      {action.detail && <p className="mt-1 text-sm" data-testid="cost-next-action-detail">{action.detail}</p>}
      {action.outstanding.length > 0 && (
        <details className="mt-2 text-sm" data-testid="cost-outstanding">
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline">{action.outstanding.length} outstanding supplier-pricing item{action.outstanding.length === 1 ? "" : "s"}</summary>
          <ul className="list-disc pl-5">{action.outstanding.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

/**
 * The legacy Cin7 cost capture, cost overrides and margin sheet, kept reachable (nothing is deleted) but out of the normal view of a quotation priced by Phase 2 supplier pricing. Its body is mounted
 * only once opened, so the legacy panels do not run beside the supplier-pricing workspace. It opens by itself when an incomplete legacy cost override needs fixing.
 */
export function LegacyCostingDisclosure({ children, defaultOpen = false }: { children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]); // an incomplete legacy cost override that must be fixed opens it
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-3" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="disc-legacy-costing">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-slate-900">Legacy costing (not used for this quotation)</span>
        <span className="text-xs text-slate-700">Cin7 cost capture, cost overrides and the price-list margin sheet. This quotation is priced from the supplier pricing above; existing legacy data is kept and unchanged.</span>
      </summary>
      {open && <div className="mt-3 space-y-6" data-testid="legacy-costing-body">{children}</div>}
    </details>
  );
}
