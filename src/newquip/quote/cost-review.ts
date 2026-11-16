// THE ITEMISED COST REVIEW (Estimator and Manager, cost-entitled viewers only), as data. One row per supplier-costed product with everything a reviewer needs side by side: what it is, how many, where the
// cost came from and when, the original cost, any historical uplift, the exchange rate and freight used, the adjusted landed unit cost, the total cost, the selling value, the margin and the verification
// state. Pure: it only ARRANGES values the pricing model and the pricing workspace view already hold. It calculates no price and no cost, and it never invents a value: anything the model does not hold is
// reported as missing, in words.
//
// HISTORICAL UPLIFT: the pricing model has NO age-based escalation of old costs (a cost is used exactly as entered; only exchange rates have an age limit). So the uplift column is always "none applied" and
// says why; no percentage is invented here. If an escalation policy is ever approved it is a pricing-model change, not a presentation one.
import { formatZarCents } from "@/lib/format-money";
import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { PricingWorkspaceView, SkuRow } from "@/newquip/pricing/estimator/workspace-view";

export type ReviewTone = "ok" | "open" | "missing";
export interface ReviewCell { text: string; tone?: ReviewTone }
export interface CostReviewRow {
  sku: string; description: string; quantity: ReviewCell; source: ReviewCell; costDate: ReviewCell; originalCost: ReviewCell; uplift: ReviewCell; fx: ReviewCell; freight: ReviewCell;
  landedUnit: ReviewCell; totalCost: ReviewCell; selling: ReviewCell; margin: ReviewCell; status: ReviewCell; missing: string[];
}
export interface CostReview { rows: CostReviewRow[]; counts: { products: number; verified: number; missing: number; unverified: number }; upliftNote: string }

export const UPLIFT_NONE = "None applied";
export const UPLIFT_NOTE = "Historical cost uplift: none applied. The pricing model has no age-based escalation of old costs: each cost is used exactly as entered. Only exchange rates have an age limit.";

const MISSING = (text: string): ReviewCell => ({ text, tone: "missing" });
const money = (c: number | null): ReviewCell => (c == null ? MISSING("Not available") : { text: formatZarCents(c) });

/** A native unit cost held in 1e-7 units, shown exactly (up to 7 decimals, trailing zeros trimmed, never rounded). */
export function nativeCostText(e7: number, currency: string): string {
  const whole = Math.trunc(e7 / 1e7); const frac = String(Math.abs(e7) % 1e7).padStart(7, "0").replace(/0+$/, "");
  return `${currency} ${whole}${frac ? `.${frac}` : ""}`;
}

function describe(budget: BudgetQuote | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of budget?.lines ?? []) {
    if (l.sku && !m.has(l.sku)) m.set(l.sku, l.label);
    for (const c of l.components ?? []) if (c.sku && !m.has(c.sku)) m.set(c.sku, c.description);
  }
  return m;
}

function rowOf(r: SkuRow, desc: Map<string, string>): CostReviewRow {
  const missing: string[] = [];
  const need = (cell: ReviewCell, what: string): ReviewCell => { if (cell.tone === "missing") missing.push(what); return cell; };
  const entered = r.status !== "no_input" && r.costState !== "missing";
  const source: ReviewCell = !entered ? MISSING("No supplier cost entered") : { text: [r.supplier, r.costSource].filter(Boolean).join(" · ") || "Source not recorded", ...(r.supplier || r.costSource ? {} : { tone: "missing" as const }) };
  const date: ReviewCell = r.enteredAt ? { text: r.enteredAt.slice(0, 10) } : MISSING(entered ? "Date not recorded" : "—");
  const original: ReviewCell = r.nativeUnitCostE7 != null && r.currency ? { text: nativeCostText(r.nativeUnitCostE7, r.currency) } : MISSING("Not entered");
  const fx: ReviewCell = !r.currency ? MISSING("—")
    : r.currency === "ZAR" ? { text: "ZAR: no conversion" }
    : r.rate ? { text: `${r.rate.currency} ${(r.rate.rateMicro / 1e6).toFixed(4)} · ${r.rate.kind === "forward_cover" ? "forward cover" : "spot"}${r.rate.asOf ? ` · ${r.rate.asOf.slice(0, 10)}` : ""}` }
    : MISSING("No usable exchange rate");
  const freight: ReviewCell = r.freightFactorMicro == null && r.freightAddOnCents == null ? MISSING("Not recorded")
    : { text: [r.freightFactorMicro != null ? `× ${(r.freightFactorMicro / 1e6).toFixed(3)}` : null, r.freightAddOnCents ? `+ ${formatZarCents(r.freightAddOnCents)}` : null].filter(Boolean).join(" ") || "None" };
  const status: ReviewCell = r.costState === "verified" ? { text: "Verified", tone: "ok" }
    : r.costState === "missing" ? MISSING("Cost missing")
    : { text: r.costStateText || (r.costState === "self_reviewed" ? "Reviewed by the person who entered it: not independent" : r.costState === "review_outdated" ? "Changed since it was verified" : "Not yet verified"), tone: "open" };
  const margin: ReviewCell = r.margin?.marginPct != null ? { text: `${r.margin.marginPct.toFixed(1)}%` } : MISSING("Not available");
  const row: CostReviewRow = {
    sku: r.sku, description: desc.get(r.sku) ?? r.usedBy.join(", "), quantity: { text: r.quantity.toLocaleString("en-US") },
    source: need(source, "supplier cost"), costDate: date, originalCost: need(original, "original cost"), uplift: { text: UPLIFT_NONE }, fx: need(fx, "exchange rate"), freight: freight,
    landedUnit: money(r.unitLandedCostCents), totalCost: money(r.lineCostCents), selling: money(r.lineRevenueCents), margin, status, missing,
  };
  return row;
}

export function buildCostReview(view: PricingWorkspaceView, budget: BudgetQuote | null): CostReview {
  const desc = describe(budget);
  const rows = view.rows.filter((r) => r.usedBy.length > 0).map((r) => rowOf(r, desc));
  return {
    rows,
    counts: { products: rows.length, verified: rows.filter((r) => r.status.tone === "ok").length, missing: rows.filter((r) => r.status.text === "Cost missing").length, unverified: rows.filter((r) => r.status.tone === "open").length },
    upliftNote: UPLIFT_NOTE,
  };
}
