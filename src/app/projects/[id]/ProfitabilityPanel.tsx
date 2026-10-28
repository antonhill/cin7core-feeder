"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import type { MarginFigures } from "@/lib/projects/margin-figures";
import { getProfitabilityAction, type ProfitabilityActionResult } from "../profitability-actions";

// INTERNAL (managers only). Consolidated base + variation position: contract, billing, estimated margins (frozen at approval) and - only when
// delivery and billing are complete - the actual margin. The reporting basis and date are always shown; a partial cost is never a margin.
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);
const Row = ({ label, m }: { label: string; m: MarginFigures }) => (
  <tr className="border-b border-slate-100"><td className="py-2 pr-3">{label}</td>
    <td className="py-2 pr-3 text-right tabular-nums">{formatCents(m.sellingCents)}</td><td className="py-2 pr-3 text-right tabular-nums">{m.costCents === null ? "—" : formatCents(m.costCents)}</td>
    <td className="py-2 pr-3 text-right tabular-nums">{m.gpCents === null ? "—" : formatCents(m.gpCents)}</td><td className="py-2 pr-3 text-right tabular-nums">{pct(m.marginPct)}</td><td className="py-2 text-right tabular-nums">{pct(m.markupPct)}</td></tr>
);

export function ProfitabilityPanel({ view }: { view: ProjectView }) {
  const [res, setRes] = useState<ProfitabilityActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); setRes(await getProfitabilityAction(view.project.id)); setBusy(false); };
  const r = res?.ok ? res.data : undefined;

  return (
    <div className="mt-6 space-y-6">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PanelTitle>Project profitability (internal)</PanelTitle>
          <Button size="sm" variant="secondary" disabled={busy} onClick={load}>{busy ? "Reading Cin7…" : r ? "Refresh" : "Calculate (reads Cin7)"}</Button>
        </div>
        {res && !res.ok && <Alert tone="danger">{res.error}</Alert>}
        {r && (
          <div className="mt-3 space-y-5 text-sm">
            <p className="text-xs text-slate-500">{r.reportingBasis} As of {new Date(r.asOf).toLocaleString()}.</p>
            <dl className="grid max-w-2xl grid-cols-2 gap-y-1">
              <dt className="text-slate-600">Original contract</dt><dd className="text-right tabular-nums">{formatCents(r.contract.originalCents)}</dd>
              <dt className="text-slate-600">Approved variations</dt><dd className="text-right tabular-nums">{formatCents(r.contract.approvedVariationsCents)}</dd>
              <dt className="font-semibold">Revised contract</dt><dd className="text-right font-semibold tabular-nums">{formatCents(r.contract.revisedCents)}</dd>
              <dt className="text-slate-600">Claimed / committed</dt><dd className="text-right tabular-nums">{formatCents(r.billing.committedCents)}</dd>
              <dt className="text-slate-600">Invoiced in Cin7</dt><dd className="text-right tabular-nums">{formatCents(r.billing.postedToCin7Cents)}</dd>
              <dt className="text-slate-600">Approved, not yet in Cin7</dt><dd className="text-right tabular-nums">{formatCents(r.billing.unpostedApprovedCents)}</dd>
              <dt className="text-slate-600">Remaining to claim</dt><dd className="text-right tabular-nums">{formatCents(r.billing.remainingToClaimCents)}</dd>
            </dl>
            <div className="overflow-x-auto">
              <p className="mb-1 font-medium text-slate-800">Estimated margin (frozen at approval; PROVISIONAL costs)</p>
              <table className="min-w-full"><thead><tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500"><th className="py-2 pr-3" /><th className="py-2 pr-3 text-right">Selling</th><th className="py-2 pr-3 text-right">Est. cost</th><th className="py-2 pr-3 text-right">Gross profit</th><th className="py-2 pr-3 text-right">Margin</th><th className="py-2 text-right">Markup</th></tr></thead>
                <tbody><Row label="Original" m={r.estimated.original} /><Row label="Variations" m={r.estimated.variations} /><Row label="Revised" m={r.estimated.revised} /></tbody></table>
              {r.estimated.uncostedSellingCents > 0 && <p className="mt-1 text-xs text-slate-500">{formatCents(r.estimated.uncostedSellingCents)} of services (e.g. delivery, installation) has no recorded cost and is excluded from these margins.</p>}
              {r.estimated.incomplete && <Alert tone="warning">Some scopes have no estimated cost; their margin (and the revised total) is withheld.</Alert>}
            </div>
            <div>
              <p className="font-medium text-slate-800">Actual (Cin7-recognised) {r.actual.meaningful ? "" : "- to date only"}</p>
              <dl className="mt-1 grid max-w-2xl grid-cols-2 gap-y-1">
                <dt className="text-slate-600">Cost recognised in Cin7 to date</dt><dd className="text-right tabular-nums">{r.actual.recognisedCostToDateCents === null ? "not read" : formatCents(r.actual.recognisedCostToDateCents)}</dd>
                <dt className="text-slate-600">Invoiced to date (ex VAT)</dt><dd className="text-right tabular-nums">{formatCents(r.actual.invoicedToDateCents)}</dd>
                <dt className="text-slate-600">Project margin on actuals</dt><dd className="text-right tabular-nums">{r.actual.projectMargin ? `${pct(r.actual.projectMargin.marginPct)} (${formatCents(r.actual.projectMargin.gpCents ?? 0)})` : "not meaningful yet"}</dd>
              </dl>
              <p className="mt-1 text-xs text-slate-500">{r.actual.reason}</p>
            </div>
            {r.exceptions.length > 0 && <div className="space-y-1"><p className="font-medium text-slate-800">Exceptions</p>{r.exceptions.map((e, i) => <Alert key={i} tone="warning">{e.code}: {e.message}</Alert>)}</div>}
          </div>
        )}
      </Panel>
    </div>
  );
}
