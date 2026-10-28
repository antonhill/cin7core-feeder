import type { QuoteDraft } from "./draft";
import type { BudgetQuote } from "./quote-bridge";
import type { GrowerCalculationResult } from "./types";

// ESTIMATOR REVIEW / QUOTE READINESS — one compact surface. Pure.
//
//   DRAFT    the engineering inputs are not yet valid (or the quote has no customer/site), so nothing meaningful can be priced.
//   BLOCKED  a REQUIRED commercial value/input genuinely remains unresolved.
//   READY    nothing required is outstanding — ready for review / quote.
//
// A manual-by-design item (feeder/drinker/slat quantity, M75, doors…) is NEVER a defect once the estimator has supplied it:
// supplying it moves it from "required" to the "estimator inputs" count.

export type ReadinessState = "DRAFT" | "BLOCKED" | "READY";
export const READINESS_LABEL: Record<ReadinessState, string> = { DRAFT: "DRAFT", BLOCKED: "BLOCKED", READY: "READY FOR REVIEW / QUOTE" };

export type ReadinessCategory =
  | "autoCalculated"
  | "suggestedDefault"
  | "estimatorInputs"
  | "overrides"
  | "warnings"
  | "missingMappings"
  | "supplierQuoteRequired"
  | "pricingExceptions";

export interface ReadinessItem {
  label: string;
  detail: string;
}

export interface Readiness {
  state: ReadinessState;
  /** Why the state is DRAFT / BLOCKED (empty when READY). */
  reasons: string[];
  counts: Record<ReadinessCategory, number>;
  items: Record<ReadinessCategory, ReadinessItem[]>;
}

const empty = (): Record<ReadinessCategory, ReadinessItem[]> => ({
  autoCalculated: [], suggestedDefault: [], estimatorInputs: [], overrides: [], warnings: [],
  missingMappings: [], supplierQuoteRequired: [], pricingExceptions: [],
});

export function assessReadiness(draft: QuoteDraft, calc: GrowerCalculationResult, budget: BudgetQuote | null): Readiness {
  const items = empty();
  const reasons: string[] = [];

  if (!draft.customerName.trim()) reasons.push("Customer name is required.");
  if (!draft.siteName.trim()) reasons.push("Site / project name is required.");
  const invalid = calc.issues.filter((i) => i.code !== "unsupported_selection");
  for (const i of calc.issues) {
    if (i.code === "unsupported_selection") items.warnings.push({ label: i.field, detail: i.message });
  }

  if (!calc.valid) {
    for (const i of invalid) reasons.push(i.message);
    return finish("DRAFT", reasons, items);
  }

  if (calc.derived.floorAreaM2 != null) {
    items.autoCalculated.push({ label: "Room floor area", detail: `${draft.config.lengthM} m × ${draft.config.widthM} m = ${Math.round(calc.derived.floorAreaM2 * 1000) / 1000} m²` });
  }
  for (const l of calc.lines) {
    if (l.exclusionReason) { items.warnings.push({ label: l.label, detail: `Excluded at the customer's request — ${l.exclusionReason}` }); continue; }
    switch (l.basis) {
      case "system_calculated": items.autoCalculated.push({ label: l.label, detail: `${l.quantityPerRoom} per room × ${calc.derived.rooms} rooms = ${l.projectQuantity}` }); break;
      case "system_default": items.suggestedDefault.push({ label: l.label, detail: `Default minimum ${l.quantityPerRoom} per room × ${calc.derived.rooms} rooms = ${l.projectQuantity}` }); break;
      case "estimator_input": items.estimatorInputs.push({ label: l.label, detail: `${l.quantityPerRoom} per room × ${calc.derived.rooms} rooms = ${l.projectQuantity}${l.suggestedQuantityPerRoom != null ? ` (suggestion ${l.suggestedQuantityPerRoom} per room)` : ""}` }); break;
      case "manual_override":
        items.overrides.push({ label: l.label, detail: `${l.quantityPerRoom} per room (default ${l.defaultQuantityPerRoom ?? "—"}) — ${l.overrideReason ?? "REASON MISSING"}` });
        if (!l.overrideReason) reasons.push(`${l.label}: override reason required`);
        break;
      default: break;
    }
  }

  if (budget) {
    for (const c of budget.charges) {
      if (c.amountExTax != null) items.estimatorInputs.push({ label: c.label, detail: `Estimator-entered amount (ex VAT)` });
    }
    for (const b of budget.lines) {
      if (b.pricedBy === "estimator_input") items.estimatorInputs.push({ label: `${b.label} — commercial price`, detail: b.reason });
      if (b.pricedBy === "penning_rate") items.autoCalculated.push({ label: `${b.label} — priced`, detail: b.reason });
      if (b.pricedBy === "estimator_resolution") items.pricingExceptions.push({ label: b.label, detail: b.reason });
      if (b.status === "unmapped" || b.status === "package_unconfirmed" || b.status === "not_in_price_source" || b.status === "package_incomplete") {
        items.missingMappings.push({ label: b.label, detail: b.reason });
      }
      if (b.status === "supplier_quote_required") items.supplierQuoteRequired.push({ label: b.label, detail: b.reason });
      for (const c of b.components ?? []) {
        if (c.status === "supplier_quote_required") {
          // Inside an estimator-priced system (M75) the supplier-quote item is resolved by the higher-level price.
          const resolved = b.status === "priced";
          items.supplierQuoteRequired.push({ label: `${c.sku ?? c.description}`, detail: `${c.reason}${resolved ? " Covered by the estimator's higher-level price." : ""}` });
        }
        if (c.status === "identity_unresolved" && b.status !== "priced") items.missingMappings.push({ label: `${b.label}: ${c.description}`, detail: c.reason });
      }
    }
    for (const w of budget.warnings) items.warnings.push({ label: "Pricing", detail: w });
    for (const x of budget.blockers) reasons.push(x);
  }

  const state: ReadinessState = reasons.length > 0 ? (reasons.every((r) => /customer name|site/i.test(r)) ? "DRAFT" : "BLOCKED") : "READY";
  return finish(state, [...new Set(reasons)], items);
}

function finish(state: ReadinessState, reasons: string[], items: Record<ReadinessCategory, ReadinessItem[]>): Readiness {
  const counts = Object.fromEntries((Object.keys(items) as ReadinessCategory[]).map((k) => [k, items[k].length])) as Record<ReadinessCategory, number>;
  return { state, reasons, counts, items };
}
