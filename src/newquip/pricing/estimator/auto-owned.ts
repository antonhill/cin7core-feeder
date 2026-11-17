import { SUPPLIER_AUTO_RULE_VERSION } from "../model";
import type { EstimatorPricing } from "./types";

// WHO OWNS A QUOTATION'S PRICING, and what to do about an automatic-pricing exception. Pure. It lives in the Estimator integration module because the pricing model may be reached only through it.

/** The attribution stamped on every automatic entry and revision. */
export const AUTO_ACTOR = "auto-pricing (Cin7 costs, commercial settings)";

/** Auto-pricing owns a quotation's pricing only while NOTHING in it was entered or changed by a person: every cost, the markup and the rule version are the automatic ones. */
export function isAutoOwned(p: EstimatorPricing): boolean {
  if (p.ruleVersionId !== SUPPLIER_AUTO_RULE_VERSION.id) return false;
  if (Object.keys(p.skuPriceOverrides).length > 0 || p.targetAdjustment || Object.keys(p.forwardCover).length > 0) return false;
  if (p.projectMarkup && p.projectMarkup.by !== AUTO_ACTOR) return false;
  return Object.values(p.skus).every((s) => !!s && s.by === AUTO_ACTOR && s.costKind === "cin7_auto");
}

/** The corrective action the Estimator takes for each exception (INTERNAL: shown only to cost-entitled roles, beside the stored specific reason). */
export const AUTO_FLAG_ACTION: Record<string, string> = {
  settings_incomplete: "Ask a Manager to complete the commercial settings (freight policy), then use Price from Cin7.",
  not_read: "Use Price from Cin7 to read it again; if it still fails, enter the supplier cost yourself.",
  no_cost: "Cin7 holds no supplier cost: enter a supplier quotation cost yourself.",
  cost_needs_review: "Check the supplier records for this product in Cin7, or enter the supplier cost yourself.",
  cost_too_old: "The Cin7 cost is older than the allowed maximum: get a current supplier quotation and enter it.",
  currency_unknown: "Set the supplier's currency in Cin7, or enter the cost with a reasoned currency override.",
  fx_missing: "Ask a Manager to enter the exchange rate in the commercial settings, then use Price from Cin7.",
  fx_stale: "Ask a Manager to refresh the exchange rate in the commercial settings, then use Price from Cin7.",
  cost_precision: "Enter the supplier cost yourself (the Cin7 figure cannot be held exactly).",
};
export const autoFlagAction = (code: string): string => AUTO_FLAG_ACTION[code] ?? "Enter the supplier cost yourself.";
