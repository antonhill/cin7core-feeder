"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatSast } from "@/lib/approvals/time";
import type { ProjectView } from "@/lib/projects/project-view";
import { purchasePosition, type TargetRow } from "@/lib/projects/procurement-targets";
import { getProcurementTargetsAction, type ProcurementResult } from "../procurement-actions";

// PROCUREMENT / COST TARGETS: what the buyer needs to know before negotiating. "Allowed" is the cost the approved quotation's estimate carried and is FROZEN;
// "Today" is Cin7's latest cost read just now; "Actual" is only what Cin7 has recognised on invoiced lines. They are never merged, and a "?" is an unknown, not zero.
const rand = (c: number | null) => (c === null ? "?" : `R ${(c / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const q = (n: number | null) => (n === null ? "?" : String(n));
const orig = (micro: number | null, cur: string | null) => (micro === null ? "?" : `${cur ?? "?"} ${(micro / 1_000_000).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);
const optKey = (id: string | null, name: string | null) => `${id ?? ""}|${name ?? ""}`;

/** Planning only: compare today's suppliers (each in its own currency and in rand) against the approved target. Nothing here edits the approved baseline or buys anything. */
function SupplierCompare({ row }: { row: TargetRow }) {
  const [pick, setPick] = useState<string>(row.approvedBasisDetail ? optKey(row.approvedBasisDetail.supplierId, row.supplier) : "");
  if (row.currentOptions.length === 0) return null;
  const sel = row.currentOptions.find((o) => optKey(o.supplierId, o.supplierName) === pick);
  const pos = sel ? purchasePosition(row, { supplierId: sel.supplierId, supplierName: sel.supplierName }) : null;
  return (
    <div className="mt-1 rounded border border-slate-200 bg-slate-50 p-2 text-xs" aria-label={`Supplier comparison for ${row.sku}`}>
      <ul className="space-y-0.5">
        {row.currentOptions.map((o) => (
          <li key={optKey(o.supplierId, o.supplierName)} className="flex flex-wrap items-baseline gap-x-3">
            <label className="flex items-center gap-1"><input type="radio" name={`buy-${row.sku}`} checked={pick === optKey(o.supplierId, o.supplierName)} onChange={() => setPick(optKey(o.supplierId, o.supplierName))} /><span className="font-medium">{o.supplierName ?? o.supplierId ?? "(unnamed)"}</span></label>
            <span className="tabular-nums">{orig(o.priceMicro, o.currency)}</span>
            {o.fx && <span className="text-slate-500">x {o.fx.rate} ({formatSast(o.fx.asOf)})</span>}
            <span className="tabular-nums">{o.zarUnitCents === null ? <Badge tone="danger">Unusable</Badge> : rand(o.zarUnitCents)}</span>
            {o.problems.filter((p) => p.blocking).map((p, i) => <span key={i} className="text-red-700">{p.message}</span>)}
          </li>
        ))}
      </ul>
      {pos && (pos.usable
        ? <div className="mt-1">Expected purchase cost: <strong className="tabular-nums">{rand(pos.totalCents)}</strong> for {row.requiredQuantity}; against the approved target <span className={pos.varianceTotalCents !== null && pos.varianceTotalCents > 0 ? "text-red-700" : ""}>{pos.varianceTotalCents === null ? "(no approved cost)" : `${pos.varianceTotalCents > 0 ? "+" : ""}${rand(pos.varianceTotalCents)}`}</span></div>
        : <div className="mt-1 text-red-700">{pos.reason}</div>)}
    </div>
  );
}

const BASIS = { CIN7_LATEST: "Cin7 latest", MANUAL_ESTIMATE: "Manual estimate", NOT_CAPTURED: "Not captured" } as const;

export function ProcurementPanel({ view }: { view: ProjectView }) {
  const [res, setRes] = useState<ProcurementResult | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); setRes(await getProcurementTargetsAction(view.project.id)); setBusy(false); };
  const d = res?.ok ? res.data : null;

  return (
    <div className="mt-6 space-y-6">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PanelTitle>Procurement / cost targets</PanelTitle>
          <Button size="sm" variant="secondary" disabled={busy} onClick={load}>{busy ? "Reading Cin7…" : d ? "Refresh from Cin7" : "Read from Cin7"}</Button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Read-only. Required quantities come from the approved quotation&apos;s scope; stock and today&apos;s cost are read from Cin7 just now. The allowed cost is frozen with the approval and never changes when Cin7 costs do.</p>
        {res && !res.ok && <div className="mt-2"><Alert tone="danger">{res.error}</Alert></div>}
        {d && (
          <>
            <p className="mt-2 text-sm text-slate-600">{d.reference} · {d.saleLinked ? `Cin7 Sale ${d.saleNumber ?? ""}` : "No Cin7 Sale linked yet - stock and order positions are unknown"} · as of {formatSast(d.asOf)}</p>
            {d.notes.map((n, i) => <div key={i} className="mt-2"><Alert tone="warning">{n}</Alert></div>)}
            {d.scopeBlockers.length > 0 && <div className="mt-2"><Alert tone="warning">Unmapped scope (no SKU to buy yet): {d.scopeBlockers.join(" | ")}</Alert></div>}
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 p-3"><div className="text-xs text-slate-500">Allowed (approved estimate)</div><div className="mt-1 text-lg font-semibold tabular-nums">{rand(d.totals.approvedTotalCents)}</div>{d.totals.missingApproved > 0 && <div className="text-xs text-amber-700">{d.totals.missingApproved} SKU(s) without an approved cost</div>}</div>
              <div className="rounded-lg border border-slate-200 p-3"><div className="text-xs text-slate-500">At today&apos;s Cin7 latest cost</div><div className="mt-1 text-lg font-semibold tabular-nums">{rand(d.totals.currentTotalCents)}</div>{d.totals.missingCurrent > 0 && <div className="text-xs text-amber-700">{d.totals.missingCurrent} SKU(s) without a usable cost today</div>}</div>
              <div className="rounded-lg border border-slate-200 p-3"><div className="text-xs text-slate-500">Difference (today - allowed)</div><div className={`mt-1 text-lg font-semibold tabular-nums ${d.totals.varianceCents !== null && d.totals.varianceCents > 0 ? "text-red-700" : ""}`}>{rand(d.totals.varianceCents)}</div></div>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 pr-3">SKU</th><th className="pr-3 text-right">Required</th><th className="pr-3 text-right">Available</th><th className="pr-3 text-right">Ordered</th><th className="pr-3 text-right">Shortfall</th><th className="pr-3 text-right">Allowed / unit</th><th className="pr-3 text-right">Allowed total</th><th className="pr-3 text-right">Same supplier today</th><th className="pr-3 text-right">Diff / unit</th><th className="pr-3 text-right">Actual / unit</th><th>Basis</th></tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.sku} className="border-t border-slate-100 align-top">
                      <td className="py-1 pr-3"><span className="font-medium">{r.sku}</span><div className="text-xs text-slate-500">{r.description}</div>{r.flags.map((f, i) => <div key={i} className="text-xs text-amber-700">{f}</div>)}<SupplierCompare row={r} /></td>
                      <td className="pr-3 text-right tabular-nums">{r.requiredQuantity}</td>
                      <td className="pr-3 text-right tabular-nums">{q(r.available)}</td>
                      <td className="pr-3 text-right tabular-nums">{q(r.ordered)}</td>
                      <td className="pr-3 text-right tabular-nums">{r.shortfall === null ? "?" : r.shortfall > 0 ? <Badge tone="warning">{r.shortfall}</Badge> : "0"}</td>
                      <td className="pr-3 text-right tabular-nums">{rand(r.approvedUnitCostCents)}</td>
                      <td className="pr-3 text-right tabular-nums">{rand(r.approvedTotalCostCents)}</td>
                      <td className="pr-3 text-right tabular-nums">{rand(r.currentUnitCostCents)}</td>
                      <td className={`pr-3 text-right tabular-nums ${r.unitVarianceCents !== null && r.unitVarianceCents > 0 ? "text-red-700" : ""}`}>{r.unitVarianceCents === null ? "?" : `${r.unitVarianceCents > 0 ? "+" : ""}${rand(r.unitVarianceCents)}`}</td>
                      <td className="pr-3 text-right tabular-nums">{rand(r.actualUnitCostCents)}</td>
                      <td className="text-xs">{BASIS[r.approvedBasis]}{r.supplier ? ` · ${r.supplier}` : ""}{r.approvedReason ? ` · ${r.approvedReason}` : ""}{r.approvedBasisDetail ? <div className="text-slate-600">approved at {orig(r.approvedBasisDetail.originalPriceMicro, r.approvedBasisDetail.currency)}{r.approvedBasisDetail.fx ? ` x ${r.approvedBasisDetail.fx.rate} (${r.approvedBasisDetail.fx.source}, ${formatSast(r.approvedBasisDetail.fx.asOf)})` : ""}{r.approvedBasisDetail.selectionMethod ? ` · ${r.approvedBasisDetail.selectionMethod === "AUTO_SINGLE" ? "only supplier" : r.approvedBasisDetail.selectionMethod === "PREFERRED" ? "preferred supplier" : "chosen by estimator"}` : ""}</div> : null}{r.approvedAt ? <div className="text-slate-500">{formatSast(r.approvedAt)}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-500">&quot;Actual&quot; is the cost Cin7 has recognised on invoiced lines and is shown only to administrators. Purchase orders, receiving and supplier selection are done in Cin7.</p>
          </>
        )}
      </Panel>
    </div>
  );
}
