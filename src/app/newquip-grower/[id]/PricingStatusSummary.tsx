"use client";
// ONE pricing-status summary (replaces the repeated warning banners). Amber for provisional or incomplete pricing (information, not an error); red is NOT used here: it is reserved for genuine errors or blocked
// actions elsewhere. Rep-safe: selling prices, labels, quantities and plain wording only (never a product code, cost, rate, freight or margin). The detail is expandable.
import { fmtZar } from "../fields";
import type { BudgetPricingView } from "@/newquip/grower/budget-pricing";
import { incompleteEstimateText } from "@/newquip/grower/incomplete-estimate";

const box = "rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950";
const ok = "rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950";

export function PricingStatusSummary({ view }: { view: BudgetPricingView | undefined }) {
  if (!view) return null;
  const { counts } = view;
  const unpriced = view.incomplete; // no total is available (an unpriced item, or any other open blocker)
  const allPriced = !unpriced && counts.provisional === 0;
  const headline = unpriced
    ? view.unpricedItems.length > 0
      ? `Priced subtotal ${fmtZar(view.subtotalExVat)} ex VAT. A total is not available: ${view.unpricedItems.length} item${view.unpricedItems.length === 1 ? " has" : "s have"} no price yet.`
      : `Priced subtotal ${fmtZar(view.subtotalExVat)} ex VAT. A total is not available while pricing is still under review.`
    : counts.provisional > 0
      ? `Provisional estimate ${fmtZar(view.estimatedTotalExVat as number)} ex VAT (${fmtZar(view.estimatedTotalIncVat as number)} inc VAT). ${counts.provisional} line${counts.provisional === 1 ? " is" : "s are"} provisional and most likely to change.`
      : `Estimated total ${fmtZar(view.estimatedTotalExVat as number)} ex VAT. Every line is priced; the Estimator still verifies it.`;
  return (
    <div className={allPriced ? ok : box} data-testid="pricing-status" data-state={unpriced ? "incomplete" : counts.provisional > 0 ? "provisional" : "priced"}>
      <p className="font-semibold" data-testid="pricing-status-headline">{headline}</p>
      <p className="mt-1 text-xs">Priced {counts.priced} · Provisional {counts.provisional} · Unpriced {counts.unpriced}. These are estimates, not verified prices or a final quotation.</p>
      <details className="mt-2">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium underline">Show the detail</summary>
        <div className="mt-2 space-y-3" data-testid="pricing-status-detail">
          {counts.provisional > 0 && (
            <div>
              <p className="font-medium">Provisional (priced from the best information available; most likely to change)</p>
              <ul className="mt-1 list-disc pl-5" data-testid="provisional-lines">
                {view.lines.filter((l) => l.state === "provisional").map((l) => <li key={l.itemKey}><strong>{l.label}</strong>{l.quantity != null ? ` × ${l.quantity}` : ""} {"—"} {fmtZar(l.amountExVat ?? 0)}. {l.note}</li>)}
              </ul>
            </div>
          )}
          {counts.unpriced > 0 && (
            <div>
              <p className="font-medium">{incompleteEstimateText(counts.unpriced)}</p>
              <ul className="mt-1 list-disc pl-5" data-testid="unpriced-lines">
                {view.lines.filter((l) => l.state === "unpriced").map((l) => <li key={l.itemKey}>{l.label}{l.quantity != null ? ` × ${l.quantity}` : ""} {"—"} {l.note}</li>)}
              </ul>
            </div>
          )}
          <div>
            <p className="font-medium">Priced ({counts.priced})</p>
            <ul className="mt-1 list-disc pl-5">
              {view.lines.filter((l) => l.state === "priced").map((l) => <li key={l.itemKey}>{l.label}{l.quantity != null ? ` × ${l.quantity}` : ""} {"—"} {fmtZar(l.amountExVat ?? 0)}</li>)}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}
