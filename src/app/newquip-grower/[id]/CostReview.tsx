"use client";

import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import { buildCostReview, type ReviewCell } from "@/newquip/quote/cost-review";

// THE ONE ITEMISED COST REVIEW (Estimator and Manager only; the caller renders it only for a cost-entitled viewer). One readable table of every supplier-costed product. Missing or unverified values are shown
// in words, never blank and never invented. The table scrolls inside its own box on a narrow screen, so the page itself never scrolls sideways.
const TONE: Record<NonNullable<ReviewCell["tone"]>, string> = { ok: "text-emerald-900", open: "text-amber-900", missing: "font-semibold text-red-800" };
const cls = (c: ReviewCell): string => (c.tone ? TONE[c.tone] : "");

export function CostReview({ bundle, budget }: { bundle: WorkspaceBundle; budget: BudgetQuote }) {
  const rv = buildCostReview(bundle.view, budget);
  if (rv.rows.length === 0) return null;
  const cols: Array<[string, (r: (typeof rv.rows)[number]) => ReviewCell, boolean]> = [
    ["Quantity", (r) => r.quantity, true], ["Cost source", (r) => r.source, false], ["Cost date", (r) => r.costDate, false], ["Original cost", (r) => r.originalCost, true], ["Historical uplift", (r) => r.uplift, false],
    ["FX", (r) => r.fx, false], ["Freight", (r) => r.freight, false], ["Landed unit cost", (r) => r.landedUnit, true], ["Total cost", (r) => r.totalCost, true], ["Selling value", (r) => r.selling, true], ["Margin", (r) => r.margin, true], ["Verification", (r) => r.status, false],
  ];
  return (
    <section aria-labelledby="cr-h" className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="cost-review">
      <div className="border-b border-slate-200 px-4 py-2.5 sm:px-5">
        <h2 id="cr-h" className="text-base font-bold">Itemised cost review <span className="font-medium text-slate-600">· {rv.counts.products} product{rv.counts.products === 1 ? "" : "s"}</span></h2>
        <p className="text-sm text-slate-700" data-testid="cost-review-counts">{rv.counts.verified} verified · {rv.counts.unverified} not yet verified · {rv.counts.missing} with no supplier cost</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-600"><th scope="col" className="sticky left-0 bg-white px-4 py-2 font-semibold">Product</th>{cols.map(([h, , right]) => <th key={h} scope="col" className={`px-2 py-2 font-semibold ${right ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
          <tbody>
            {rv.rows.map((r) => (
              <tr key={r.sku} className="border-t border-slate-100 align-top" data-testid={`cost-review-${r.sku}`}>
                <th scope="row" className="sticky left-0 min-w-[12rem] bg-white px-4 py-2 text-left font-normal"><span className="block font-semibold text-slate-900">{r.sku}</span><span className="block text-xs text-slate-700">{r.description}</span></th>
                {cols.map(([h, get, right]) => { const c = get(r); return <td key={h} className={`px-2 py-2 ${right ? "whitespace-nowrap text-right tabular-nums" : ""} ${cls(c)}`}>{c.text}</td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-700 sm:px-5" data-testid="uplift-note">{rv.upliftNote}</p>
    </section>
  );
}
