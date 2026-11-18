// BUDGET PRICING SUMMARY (pure, Rep-safe). Reads an already-evaluated BUDGET evaluation (evaluateDraft with provisionalPackages) and states, line by line, what is PRICED (existing evidence, no open
// question), PROVISIONAL (priced from the existing calculation but not yet confirmed by the Estimator) and UNPRICED, plus the subtotal and, ONLY when nothing material is unpriced, an estimated total.
// Selling prices, labels, quantities and plain-English wording only: never a product code, cost, rate, freight, markup or margin. It is built from the existing calculation; it prices nothing itself.
import type { BudgetQuote } from "./quote-bridge";
import { neutralLineReason } from "./incomplete-estimate";

export type BudgetLineState = "priced" | "provisional" | "unpriced";
export interface BudgetPricingLine { itemKey: string; label: string; quantity: number | null; state: BudgetLineState; amountExVat: number | null; /** provisional: what may change; unpriced: why. */ note: string | null }
export interface BudgetPricingView {
  lines: BudgetPricingLine[];
  counts: { priced: number; provisional: number; unpriced: number };
  /** Priced + provisional equipment and every entered charge, ex VAT. A SUBTOTAL unless `estimatedTotalExVat` is set. */
  subtotalExVat: number;
  provisionalValueExVat: number;
  unpricedItems: string[];
  /** Set only when nothing is unpriced (every selected line and required charge has a price). It is an ESTIMATE: provisional lines make it "provisional". */
  estimatedTotalExVat: number | null;
  estimatedTotalIncVat: number | null;
  /** "verified-basis": no provisional lines. "provisional": at least one. null while a total is not available. */
  totalBasis: "budget" | "provisional" | null;
  /** True whenever no total is available: an unpriced line or charge, OR any other open blocker (e.g. a missing override reason). Never present a total while true. */
  incomplete: boolean;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function budgetPricingOf(budget: BudgetQuote): BudgetPricingView {
  const lines: BudgetPricingLine[] = budget.lines.filter((l) => l.status !== "not_selected").map((l) => {
    if (l.status === "priced" && l.revenueExTax != null) return { itemKey: l.itemKey, label: l.label, quantity: l.quantity, state: l.provisional ? "provisional" : "priced", amountExVat: round2(l.revenueExTax), note: l.provisional?.plain ?? null } as BudgetPricingLine;
    return { itemKey: l.itemKey, label: l.label, quantity: l.quantity, state: "unpriced", amountExVat: null, note: neutralLineReason(l.status) } as BudgetPricingLine;
  });
  const unpricedCharges = budget.charges.filter((c) => c.status === "required").map((c) => c.label);
  // Same rule as the Budget document: Commissioning is combined with Installation, so it is not counted while the Installation amount is still to be entered.
  const installEntered = budget.charges.some((c) => c.key === "installation" && c.status === "entered");
  const chargesTotal = budget.charges.filter((c) => c.key !== "commissioning" || installEntered).reduce((a, c) => a + (c.amountExTax ?? 0), 0);
  const counts = { priced: lines.filter((l) => l.state === "priced").length, provisional: lines.filter((l) => l.state === "provisional").length, unpriced: lines.filter((l) => l.state === "unpriced").length };
  const subtotal = round2(lines.reduce((a, l) => a + (l.amountExVat ?? 0), 0) + chargesTotal);
  const unpricedItems = [...lines.filter((l) => l.state === "unpriced").map((l) => `${l.label}${l.quantity != null ? ` × ${l.quantity}` : ""}`), ...unpricedCharges];
  const complete = unpricedItems.length === 0 && budget.state === "complete";
  const ratePct = round2(budget.totals.taxTotal > 0 && budget.totals.subtotalExTax > 0 ? (budget.totals.taxTotal / budget.totals.subtotalExTax) * 100 : 15);
  const vat = round2(subtotal * (ratePct / 100));
  return {
    lines, counts, subtotalExVat: subtotal, provisionalValueExVat: round2(lines.filter((l) => l.state === "provisional").reduce((a, l) => a + (l.amountExVat ?? 0), 0)), unpricedItems,
    estimatedTotalExVat: complete ? subtotal : null, estimatedTotalIncVat: complete ? round2(subtotal + vat) : null, incomplete: !complete, totalBasis: complete ? (counts.provisional > 0 ? "provisional" : "budget") : null,
  };
}

/** The note under the "Hand-off figure": it says the figure leaves lines out ONLY when provisional or unpriced lines actually remain. */
export function handoffFigureNote(view: Pick<BudgetPricingView, "counts">): string {
  return view.counts.provisional + view.counts.unpriced > 0
    ? "Leaves out provisional and unpriced lines. This is the amount the customer confirms at hand-off."
    : "No provisional or unpriced lines remain, so this matches the budget estimate. This is the amount the customer confirms at hand-off.";
}
