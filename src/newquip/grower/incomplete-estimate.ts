// INCOMPLETE ESTIMATE (customer UAT feedback, NQ-Q-0003): a quotation whose selected equipment has no confirmed selling price must never show a number that reads like a complete quotation total.
// Pure and customer-safe: it carries labels, quantities and neutral reasons only - never a SKU, cost, rate, freight or margin - so a Rep, an email or a customer PDF may use it.
// It reads the already-evaluated budget; it invents no price and changes no calculation.
import type { BridgeLine, BudgetQuote } from "./quote-bridge";

/** What the customer-safe wording calls a line's reason. Never the supplier / cost explanation. */
const NEUTRAL_REASON: Partial<Record<BridgeLine["status"], string>> = {
  no_quantity: "Quantity not yet entered",
  unmapped: "Product not yet confirmed",
  package_unconfirmed: "Product not yet confirmed",
  package_incomplete: "Price not yet confirmed",
  not_in_price_source: "Price not yet confirmed",
  supplier_quote_required: "Awaiting a confirmed price",
  estimator_price_required: "Price to be entered",
};
export const neutralLineReason = (status: BridgeLine["status"]): string => NEUTRAL_REASON[status] ?? "Price not yet confirmed";

export interface UnpricedLine { itemKey: string; label: string; quantity: number | null; reason: string }
export interface IncompleteEstimate {
  /** Selected equipment lines with no confirmed selling price. */
  lines: UnpricedLine[];
  count: number;
  /** The exact warning shown to the Rep, the Estimator and (in its budget form) the customer. */
  text: string;
  /** Delivery, installation and commissioning that have actually been entered (ex VAT). A KNOWN CHARGE SUBTOTAL, not a project estimate. */
  chargesSubtotalExVat: number;
  /** Priced equipment (ex VAT). May be 0 while everything is unpriced. */
  pricedEquipmentExVat: number;
  /** What the figures add up to today: only the known items. NEVER the total project estimate while `count` > 0. */
  knownSubtotalExVat: number;
}

const plural = (n: number) => (n === 1 ? "1 equipment line has" : `${n} equipment lines have`);
export const incompleteEstimateText = (n: number): string =>
  `INCOMPLETE ESTIMATE — ${plural(n)} no confirmed selling price. The displayed amount excludes ${n === 1 ? "this item" : "these items"} and is not a complete quotation total.`;

/** Null when every selected equipment line is priced (a complete estimate, as far as equipment goes). */
export function incompleteEstimateOf(budget: BudgetQuote | null | undefined): IncompleteEstimate | null {
  if (!budget) return null;
  const lines = budget.lines.filter((l) => l.status !== "priced" && l.status !== "not_selected").map((l): UnpricedLine => ({ itemKey: l.itemKey, label: l.label, quantity: l.quantity, reason: neutralLineReason(l.status) }));
  if (lines.length === 0) return null;
  const chargesSubtotalExVat = Math.round(budget.charges.reduce((a, c) => a + (c.amountExTax ?? 0), 0) * 100) / 100;
  const pricedEquipmentExVat = Math.round(budget.lines.filter((l) => l.status === "priced").reduce((a, l) => a + (l.revenueExTax ?? 0), 0) * 100) / 100;
  return { lines, count: lines.length, text: incompleteEstimateText(lines.length), chargesSubtotalExVat, pricedEquipmentExVat, knownSubtotalExVat: Math.round(budget.totals.subtotalExTax * 100) / 100 };
}
