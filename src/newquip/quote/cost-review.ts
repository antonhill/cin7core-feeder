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
  landedUnit: ReviewCell; totalCost: ReviewCell; selling: ReviewCell; margin: ReviewCell; status: ReviewCell; /** Extra detail for an unusual status (shown once on that row), null for the standard cases the legend explains. */ statusDetail: string | null; missing: string[];
}
export interface CostReview { rows: CostReviewRow[]; counts: { products: number; verified: number; missing: number; unverified: number; provisional: number }; upliftNote: string }

const KIND_LABEL: Record<"cin7_historical" | "supplier_quotation" | "manual_estimate" | "cin7_auto", string> = { cin7_historical: "Cin7 historical cost", supplier_quotation: "Supplier quotation", manual_estimate: "Manual estimate", cin7_auto: "Automatic Cin7 cost (age-escalated, needs verification)" };
export const STATUS_VERIFIED = "Verified";
export const STATUS_NEEDS = "Needs verification";
export const STATUS_MISSING = "Missing cost";
export const STATUS_PROVISIONAL = "Provisional";
/** The legend, shown ONCE under the table (never repeated in every row). */
export const STATUS_LEGEND: ReadonlyArray<readonly [string, string]> = [
  [STATUS_VERIFIED, "A different person has independently checked this exact supplier cost."],
  [STATUS_NEEDS, "A cost is entered but has not been independently verified (or it changed after it was). A Manager verifies it; you cannot verify your own entry."],
  [STATUS_MISSING, "No supplier cost has been entered, so this product has no supplier price yet."],
  [STATUS_PROVISIONAL, "The line is priced with a manual selling price. Its supplier cost still needs independent verification."],
];
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
  const kind = r.costKind ? KIND_LABEL[r.costKind] : null;
  const supplierLabel = r.supplier ? `${r.supplier}${r.supplierId ? " (Cin7)" : ""}` : null;
  const source: ReviewCell = !entered ? MISSING("No supplier cost entered") : { text: [supplierLabel, kind, r.costSource].filter(Boolean).join(" · ") || "Source not recorded", ...(r.supplier || r.costSource ? {} : { tone: "missing" as const }) };
  // The date the cost APPLIES to (a quotation date, or Cin7's last-supplied date). A Cin7 price with no date says so; an older entry shows only when it was entered. No date is ever invented.
  const date: ReviewCell = r.costDate ? { text: r.costDate }
    : r.costKind === "cin7_historical" ? { text: "not recorded in Cin7", tone: "open" }
    : r.enteredAt ? { text: `entered ${r.enteredAt.slice(0, 10)}` } : MISSING(entered ? "Date not recorded" : "—");
  const original: ReviewCell = r.nativeUnitCostE7 != null && r.currency ? { text: nativeCostText(r.nativeUnitCostE7, r.currency) } : MISSING("Not entered");
  const byHand = r.currencySource === "override" ? " · currency set by hand" : "";
  const fx: ReviewCell = !r.currency ? MISSING("—")
    : r.currency === "ZAR" ? { text: `ZAR: no conversion${byHand}` }
    : r.rate ? { text: `${r.rate.currency} ${(r.rate.rateMicro / 1e6).toFixed(4)} · ${r.rate.kind === "forward_cover" ? "forward cover" : "spot"}${r.rate.asOf ? ` · ${r.rate.asOf.slice(0, 10)}` : ""}${byHand}` }
    : MISSING("No usable exchange rate");
  const freight: ReviewCell = r.freightFactorMicro == null && r.freightAddOnCents == null ? MISSING("Not recorded")
    : { text: [r.freightFactorMicro != null ? `× ${(r.freightFactorMicro / 1e6).toFixed(3)}` : null, r.freightAddOnCents ? `+ ${formatZarCents(r.freightAddOnCents)}` : null].filter(Boolean).join(" ") || "None" };
  // FOUR compact labels (explained once in the legend): Verified, Needs verification, Missing cost, Provisional.
  const manual = r.priceBasis === "manual_price"; // a MANUAL selling price (no model price); an audited selling-price override on a priced line keeps its cost status
  const status: ReviewCell = r.costState === "missing" ? MISSING(STATUS_MISSING)
    : manual ? { text: STATUS_PROVISIONAL, tone: "open" }
    : r.costState === "verified" ? { text: STATUS_VERIFIED, tone: "ok" }
    : { text: STATUS_NEEDS, tone: "open" };
  const statusDetail: string | null = r.costState === "missing" ? null
    : manual ? "Priced with a manual selling price. Its supplier cost still needs independent verification."
    : r.currencySource === "override" ? `The currency was set by hand because Cin7 holds none for this supplier: ${r.currencyOverrideReason ?? "no reason recorded"}`
    : r.priceOverride != null ? "The selling price is an audited override of the model's price. The cost status above is unaffected."
    : r.costState === "self_reviewed" ? "Reviewed by the person who entered it, which is not independent."
    : r.costState === "review_outdated" ? "The cost changed after it was verified."
    : null;
  const margin: ReviewCell = r.margin?.marginPct != null ? { text: `${r.margin.marginPct.toFixed(1)}%` } : MISSING("Not available");
  const row: CostReviewRow = {
    sku: r.sku, description: desc.get(r.sku) ?? r.usedBy.join(", "), quantity: { text: r.quantity.toLocaleString("en-US") },
    source: need(source, "supplier cost"), costDate: date, originalCost: need(original, "original cost"), uplift: { text: UPLIFT_NONE }, fx: need(fx, "exchange rate"), freight: freight,
    landedUnit: money(r.unitLandedCostCents), totalCost: money(r.lineCostCents), selling: money(r.lineRevenueCents), margin, status, statusDetail, missing,
  };
  return row;
}

export function buildCostReview(view: PricingWorkspaceView, budget: BudgetQuote | null): CostReview {
  const desc = describe(budget);
  const rows = view.rows.filter((r) => r.usedBy.length > 0).map((r) => rowOf(r, desc));
  return {
    rows,
    counts: { products: rows.length, verified: rows.filter((r) => r.status.text === STATUS_VERIFIED).length, missing: rows.filter((r) => r.status.text === STATUS_MISSING).length, unverified: rows.filter((r) => r.status.text === STATUS_NEEDS).length, provisional: rows.filter((r) => r.status.text === STATUS_PROVISIONAL).length },
    upliftNote: UPLIFT_NOTE,
  };
}
