import { statusText } from "@/components/ui/Status";

// Business wording for the machine codes the physical and profitability reads raise. Anything not listed falls back to statusText (sentence case), so a code
// is never shown raw. Display only: the codes themselves are unchanged.
const LABELS: Record<string, string> = {
  NOT_ON_ORDER: "Not on the order",
  QUANTITY_DIFFERS_FROM_SCOPE: "Quantity differs from the approved scope",
  OVER_INVOICED: "Invoiced more than ordered",
  OVER_SHIPPED: "Shipped more than ordered",
  UNREADABLE_QUANTITY: "Quantity could not be read",
  STOCK_NOT_READ: "Stock was not read",
  UNORDERED_SKU_ACTIVITY: "Activity on a product that is not on the order",
  OVER_BILLED: "Billed more than the contract",
  UNPOSTED_APPROVED_CLAIM: "Approved claim not yet posted to Cin7",
  POSTING_MISMATCH: "Cin7 invoice differs from the claim",
  NO_LINKED_SALE: "No Cin7 Sale linked",
  COST_UNKNOWN: "Cost unknown",
  LINE_COST_UNKNOWN: "Line cost unknown",
  COGS_NOT_READ: "Cost of sales was not read",
  COGS_ZERO_BUT_LINES_COSTED: "Cost of sales is zero but lines are costed",
};

export function exceptionLabel(code: string): string {
  return Object.hasOwn(LABELS, code) ? LABELS[code] : statusText(code);
}
