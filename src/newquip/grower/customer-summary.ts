import type { BudgetQuote } from "./quote-bridge";
import type { GrowerItemKey } from "./types";

// CUSTOMER-FACING SUMMARY (Sean): grouped commercial sections, NOT the raw stock/BOM. No SKUs, no costs, no component lines.
// Internal estimator view keeps the detail. Pure.

export interface SummarySection {
  title: string;
  /** Plain-language scope for the customer. */
  scope: string;
  amountExVat: number;
}

const GROUPS: { title: string; scope: string; items: GrowerItemKey[]; charges?: string[] }[] = [
  { title: "Feed storage & distribution", scope: "Bulk feed storage and the M75 feed distribution system, as configured with your representative.", items: ["bulk_tank", "flex_auger"] },
  { title: "Feeding equipment", scope: "CCM feeders with feed-saver mats for each room.", items: ["feeder", "feed_saver_mat"] },
  { title: "Drinking system", scope: "Cup drinkers with pipes and brackets.", items: ["cup_drinker"] },
  { title: "Flooring", scope: "Concrete slatted flooring, including crane-truck delivery of slats.", items: ["concrete_slat"], charges: ["concrete_slat_delivery"] },
  { title: "Penning", scope: "Polypropylene penning supplied by the running metre.", items: ["penning_package"] },
  { title: "Lighting & doors", scope: "LED lighting and PVC doors with frames.", items: ["led_light", "pvc_door"] },
  { title: "Ventilation & controls (optional scope)", scope: "Optional ventilation, cooling and control equipment, where selected.", items: ["controller", "silo_weighing", "control_panel", "emergency_windows", "pad_cooling", "cone_fans", "manure_plug"] },
  { title: "Delivery", scope: "Delivery of the equipment to site.", items: [], charges: ["delivery"] },
  { title: "Installation", scope: "Installation of the equipment on site.", items: [], charges: ["installation"] },
];

export interface CustomerSummary {
  sections: SummarySection[];
  subtotalExVat: number;
  vat: number;
  totalIncVat: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Only when the budget is complete does a customer summary exist — an incomplete quote is never shown to a customer. */
export function buildCustomerSummary(budget: BudgetQuote): CustomerSummary | null {
  if (budget.incomplete || budget.state !== "complete") return null;
  const sections: SummarySection[] = [];
  for (const g of GROUPS) {
    const lineSum = budget.lines.filter((l) => g.items.includes(l.itemKey) && l.status === "priced").reduce((a, l) => a + (l.revenueExTax ?? 0), 0);
    const chargeSum = budget.charges.filter((c) => g.charges?.includes(c.key)).reduce((a, c) => a + (c.amountExTax ?? 0), 0);
    const amount = round2(lineSum + chargeSum);
    if (amount > 0) sections.push({ title: g.title, scope: g.scope, amountExVat: amount });
  }
  return { sections, subtotalExVat: round2(budget.totals.subtotalExTax), vat: round2(budget.totals.taxTotal), totalIncVat: round2(budget.totals.totalIncTax) };
}
