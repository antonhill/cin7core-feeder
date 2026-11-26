"use client";

import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import { formatZarCents } from "@/lib/format-money";
import { buildCostReview, groupCostReview, STATUS_LEGEND, type ReviewCell } from "@/newquip/quote/cost-review";

// THE ONE ITEMISED COST REVIEW (Estimator and Manager only; the caller renders it only for a cost-entitled viewer). One readable table of every supplier-costed product. Missing or unverified values are shown
// in words, never blank and never invented. The table scrolls inside its own box on a narrow screen, so the page itself never scrolls sideways.
const TONE: Record<NonNullable<ReviewCell["tone"]>, string> = { ok: "text-emerald-900", open: "text-amber-900", missing: "font-semibold text-red-800" };
const cls = (c: ReviewCell): string => (c.tone ? TONE[c.tone] : "");

export function CostReview({ bundle, budget }: { bundle: WorkspaceBundle; budget: BudgetQuote }) {
  const rv = buildCostReview(bundle.view, budget);
  if (rv.rows.length === 0) return null;
  const groups = groupCostReview(rv.rows);
  const cols: Array<[string, (r: (typeof rv.rows)[number]) => ReviewCell, boolean]> = [
    ["Quantity", (r) => r.quantity, true], ["Cost date", (r) => r.costDate, false], ["Original cost", (r) => r.originalCost, true], ["Historical uplift", (r) => r.uplift, false],
    ["FX", (r) => r.fx, false], ["Freight", (r) => r.freight, false], ["Landed unit cost", (r) => r.landedUnit, true], ["Total cost", (r) => r.totalCost, true], ["Selling value", (r) => r.selling, true], ["Margin", (r) => r.margin, true], ["Verification", (r) => r.status, false],
  ];
  const cents = (c: number | null) => (c == null ? "—" : formatZarCents(c));
  return (
    <section aria-labelledby="cr-h" className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="cost-review">
      <div className="border-b border-slate-200 px-4 py-2.5 sm:px-5">
        <h2 id="cr-h" className="text-base font-bold">Itemised cost review <span className="font-medium text-slate-600">· {rv.counts.products} product{rv.counts.products === 1 ? "" : "s"} in {groups.length} equipment line{groups.length === 1 ? "" : "s"}</span></h2>
        <p className="text-sm text-slate-700" data-testid="cost-review-counts">{rv.counts.verified} verified · {rv.counts.unverified} needs verification · {rv.counts.provisional} provisional · {rv.counts.missing} missing cost</p>
        <p className="text-xs text-slate-700">Each equipment line is one summary. Open “View cost details” for every product&apos;s Cin7 supplier price, exchange rate, freight and notes.</p>
      </div>
      <ul>
        {groups.map((g, gi) => {
          const sharedFreight = g.sharedFreightSource;
          return (
            <li key={g.key} className="border-b border-slate-100 last:border-0" data-testid={`cost-group-${gi}`}>
              <div className="px-4 pt-2.5 sm:px-5">
                <p className="text-[15px] font-semibold text-slate-900" data-testid={`cost-group-title-${gi}`}>{g.label}</p>
                <p className="text-[13px] text-slate-900" data-testid={`cost-group-summary-${gi}`}>
                  {g.rows.length} {g.rows.length === 1 ? "product" : "products"} · Total cost <strong className="tabular-nums">{cents(g.totalCostCents)}</strong> · Selling value <strong className="tabular-nums">{cents(g.sellingCents)}</strong> ex VAT · {g.counts.verified} verified · {g.counts.unverified + g.counts.provisional} need verification{g.counts.missing > 0 ? ` · ${g.counts.missing} missing cost` : ""}
                </p>
                {g.warnings.length > 0 && <ul className="mt-0.5 space-y-0.5" data-testid={`cost-group-warnings-${gi}`}>{g.warnings.map((w) => <li key={w} className="text-[13px] font-semibold text-amber-900"><span aria-hidden>⚠ </span>{w}</li>)}</ul>}
              </div>
              <details open={g.needsAttention} className="px-4 pb-2 sm:px-5" data-testid={`cost-group-details-${gi}`}>
                <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-semibold text-indigo-700">View cost details <span className="ml-1 font-normal text-slate-700">· {g.rows.length} {g.rows.length === 1 ? "record" : "records"}</span></summary>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[60rem] text-sm">
                    <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-600"><th scope="col" className="sticky left-0 bg-white py-2 pr-2 font-semibold">Product</th><th scope="col" className="px-2 py-2 font-semibold">Cost source</th>{cols.map(([h, , right]) => <th key={h} scope="col" className={`px-2 py-2 font-semibold ${right ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
                    <tbody>
                      {g.rows.map((r) => (
                        <tr key={r.sku} className="border-t border-slate-100 align-top" data-testid={`cost-review-${r.sku}`}>
                          <th scope="row" className="sticky left-0 min-w-[12rem] bg-white py-2 pr-2 text-left font-normal"><span className="block font-semibold text-slate-900">{r.sku}</span><span className="block text-xs text-slate-700">{r.description}</span></th>
                          <td className={`min-w-[12rem] px-2 py-2 ${cls(r.source)}`}>
                            {r.sourceHead}
                            {(r.sourceNote || (!sharedFreight && r.freightSource)) && <details className="text-xs font-normal text-slate-700"><summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-indigo-700">Cost note</summary>{r.sourceNote}{!sharedFreight && r.freightSource ? ` Freight: ${r.freightSource}` : ""}</details>}
                          </td>
                          {cols.map(([h, get, right]) => { const c = get(r); return <td key={h} className={`px-2 py-2 ${right ? "whitespace-nowrap text-right tabular-nums" : ""} ${cls(c)}`}>{c.text}{h === "Verification" && r.statusDetail && <span className="mt-0.5 block text-xs font-normal text-slate-700" data-testid={`status-detail-${r.sku}`}>{r.statusDetail}</span>}</td>; })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {sharedFreight && <p className="mt-1 text-xs text-slate-700" data-testid={`cost-group-freight-${gi}`}>Freight, all {g.rows.length} {g.rows.length === 1 ? "product" : "products"}: {sharedFreight}</p>}
              </details>
            </li>
          );
        })}
      </ul>
      <details className="border-t border-slate-100 px-4 py-2 text-sm sm:px-5" data-testid="status-legend" open>
        <summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-slate-900">What the status labels mean</summary>
        <dl className="grid gap-x-6 gap-y-1 pb-1 sm:grid-cols-[max-content_1fr]">{STATUS_LEGEND.map(([k, v]) => <div key={k} className="contents"><dt className="font-semibold text-slate-900">{k}</dt><dd className="text-slate-800">{v}</dd></div>)}</dl>
      </details>
      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-700 sm:px-5" data-testid="uplift-note">{rv.upliftNote}</p>
    </section>
  );
}
