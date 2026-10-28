"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import type { MarginFigures } from "@/lib/projects/margin-figures";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { COST_CATEGORIES, COST_CATEGORY_LABEL } from "@/lib/projects/project-costs";
import { addCostEntryAction, getCostLedgerAction, getProfitabilityAction, markCostIncurredAction, voidCostEntryAction, type CostLedgerResult, type ProfitabilityActionResult } from "../profitability-actions";

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
              <dl className="mt-3 grid max-w-2xl grid-cols-2 gap-y-1">
                <dt className="text-slate-600">Cost on Cin7 invoice lines (qty x average cost)</dt><dd className="text-right tabular-nums">{r.actual.invoiceLineCostCents === null ? "unknown" : formatCents(r.actual.invoiceLineCostCents)}</dd>
                <dt className="text-slate-600">Non-stock costs incurred</dt><dd className="text-right tabular-nums">{r.actual.nonStockIncurredCents === null ? "ledger unavailable" : formatCents(r.actual.nonStockIncurredCents)}</dd>
                <dt className="text-slate-600">Non-stock costs committed (expected)</dt><dd className="text-right tabular-nums">{r.actual.nonStockCommittedCents === null ? "ledger unavailable" : formatCents(r.actual.nonStockCommittedCents)}</dd>
                <dt className="font-medium">Incurred cost to date</dt><dd className="text-right font-medium tabular-nums">{r.actual.incurredCostCents === null ? "unknown" : formatCents(r.actual.incurredCostCents)}</dd>
                <dt className="text-slate-600">Indicative product cost (Cin7 average cost x scope)</dt><dd className="text-right tabular-nums">{r.estimated.indicativeProductCostCents === null ? "unknown" : formatCents(r.estimated.indicativeProductCostCents)}</dd>
              </dl>
              <p className="mt-1 text-xs text-slate-500">{r.actual.costBasisNote}</p>
            </div>
            {r.exceptions.length > 0 && <div className="space-y-1"><p className="font-medium text-slate-800">Exceptions</p>{r.exceptions.map((e, i) => <Alert key={i} tone="warning">{e.code}: {e.message}</Alert>)}</div>}
          </div>
        )}
      </Panel>
      <CostLedger projectId={view.project.id} />
    </div>
  );
}

function CostLedger({ projectId }: { projectId: string }) {
  const [res, setRes] = useState<CostLedgerResult | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ category: "INSTALLATION_LABOUR", description: "", supplier: "", reference: "", amountRand: "", state: "COMMITTED", inCin7Valuation: false });
  const [why, setWhy] = useState<Record<string, string>>({});
  const load = async () => { setBusy(true); setRes(await getCostLedgerAction(projectId)); setBusy(false); };
  const act = async (fn: () => Promise<CostLedgerResult>, ok: string) => { setBusy(true); const r = await fn(); setMsg(r.ok ? ok : r.error ?? "Failed."); if (r.ok) setRes(await getCostLedgerAction(projectId)); setBusy(false); };
  const d = res?.ok ? res.data : undefined;
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Non-stock project costs (internal)</PanelTitle>
        <Button size="sm" variant="secondary" disabled={busy} onClick={load}>{d ? "Refresh" : "Open cost ledger"}</Button>
      </div>
      <p className="mt-1 text-xs text-slate-500">Installation labour, transport, subcontractors, site and other direct costs that Cin7 stock/assembly valuation does not carry (ex VAT). Committed = expected; incurred = actual. Tick &quot;already in Cin7 valuation&quot; for a cost Cin7 already carries - it is shown but never added again. Entries are never deleted; void with a reason.</p>
      {res && !res.ok && <Alert tone="danger">{res.error}</Alert>}
      {msg && <div className="mt-2 text-sm text-slate-700">{msg}</div>}
      {d && !d.available && <Alert tone="warning">The cost ledger is not available yet (database migration pending). Non-stock costs are reported as unknown, not zero.</Alert>}
      {d?.available && (
        <div className="mt-3 space-y-4 text-sm">
          {d.totals && <p className="tabular-nums">Incurred {formatCents(d.totals.incurredCents)} · Committed {formatCents(d.totals.committedCents)}{d.totals.excludedCents > 0 ? ` · Excluded (already in Cin7 valuation) ${formatCents(d.totals.excludedCents)}` : ""}</p>}
          <ul className="space-y-2">
            {d.entries.map((e) => (
              <li key={e.id} className={`flex flex-wrap items-end gap-2 ${e.voided_at ? "text-slate-400 line-through" : ""}`}>
                <span className="min-w-56">{COST_CATEGORY_LABEL[e.category]}: {e.description}{e.supplier ? ` (${e.supplier})` : ""}{e.reference ? ` [${e.reference}]` : ""}</span>
                <span className="tabular-nums">{formatCents(e.amount_cents)}</span><span className="text-xs">{e.state}{e.incurred_on ? ` ${e.incurred_on}` : ""}{e.in_cin7_valuation ? " · in Cin7 valuation (excluded)" : ""}</span>
                {!e.voided_at && e.state === "COMMITTED" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => markCostIncurredAction(projectId, e.id), "Marked incurred.")}>Mark incurred</Button>}
                {!e.voided_at && (<><Input label="Void reason" hideLabel value={why[e.id] ?? ""} placeholder="Void reason" onChange={(ev) => setWhy({ ...why, [e.id]: ev.target.value })} /><Button size="sm" variant="secondary" disabled={busy || !(why[e.id] ?? "").trim()} onClick={() => act(() => voidCostEntryAction(projectId, e.id, why[e.id]), "Voided.")}>Void</Button></>)}
              </li>
            ))}
          </ul>
          <div className="grid gap-3 sm:grid-cols-3">
            <Select label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{COST_CATEGORIES.map((c) => <option key={c} value={c}>{COST_CATEGORY_LABEL[c]}</option>)}</Select>
            <Input label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            <Input label="Amount (R, ex VAT)" value={f.amountRand} inputMode="decimal" onChange={(e) => setF({ ...f, amountRand: e.target.value })} />
            <Input label="Supplier" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} />
            <Input label="Reference (PO / invoice)" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
            <Select label="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}><option value="COMMITTED">Committed (expected)</option><option value="INCURRED">Incurred (actual)</option></Select>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={f.inCin7Valuation} onChange={(e) => setF({ ...f, inCin7Valuation: e.target.checked })} /> Already carried in a Cin7 inventory / assembly valuation (record for visibility only)</label>
          <Button disabled={busy || !f.description.trim() || !f.amountRand.trim()} onClick={() => act(async () => { const r = await addCostEntryAction(projectId, f); if (r.ok) setF({ ...f, description: "", supplier: "", reference: "", amountRand: "" }); return r; }, "Cost recorded.")}>Record cost</Button>
        </div>
      )}
    </Panel>
  );
}
