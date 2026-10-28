import type { ScopeItem } from "@/lib/projects/product-scope";
import type { BaselineCommercialLine } from "./baseline";
import { sectionOf } from "./margin";

// The approved quotation's PHYSICAL SCOPE, derived purely from the sealed commercial lines (so it can be rebuilt identically for a baseline
// sealed before this existed). Rules:
//  * a line sold as one Cin7 SKU is a FINISHED_GOOD item (SKU, quantity, selling price);
//  * a package whose components are genuine SKUs with known quantities expands into one DIRECT_COMPONENT item per component, each remembering its
//    package - the relationship is kept, the package itself is not also listed (no double counting);
//  * a package/line with NO authoritative SKU (estimator-priced systems, historic reference components, unresolved identity, penning by the
//    running metre) is reported UNMAPPED. It is never given a made-up identifier;
//  * Cin7 BOM components of an assembled finished good are not scope items at all: only what the quotation sells appears here;
//  * delivery / installation / slat-delivery are commercial charges, not products.
// No cost and no margin is carried (those stay in the access-controlled margin sheet).

const cents = (rands: number | null | undefined): number | null => (rands == null || !Number.isFinite(rands) ? null : Math.round(rands * 100));

export function buildPhysicalScope(lines: readonly BaselineCommercialLine[]): ScopeItem[] {
  const out: ScopeItem[] = [];
  for (const l of lines) {
    const section = sectionOf(l.itemKey);
    const origin = (id: string, packageKey: string | null) => ({ lineRef: id, label: l.label, packageKey, section, source: "QUOTE" as const });
    if (l.sku && !l.components) {
      out.push({ id: l.itemKey, sku: l.sku, description: l.label, quantity: l.quantity, unit: "each", productType: "FINISHED_GOOD", origin: origin(l.itemKey, null), scope: "BASE", sellingUnitCents: cents(l.unitPriceExVat), mapping: { status: "MAPPED" } });
      continue;
    }
    const comps = l.components ?? [];
    // A component is a physical product when it has a real SKU and a known positive quantity. Whether the price source could price it is a PRICING
    // matter, not a mapping one. Historic-reference components (estimator-priced systems) and unresolved identities are not authoritative.
    const priced = comps.filter((c) => c.sku && c.quantity != null && c.quantity > 0 && c.status !== "reference_only" && c.status !== "identity_unresolved");
    for (const c of priced) {
      out.push({ id: `${l.itemKey}:${c.sku}`, sku: c.sku, description: c.description, quantity: c.quantity, unit: "each", productType: "DIRECT_COMPONENT", origin: origin(`${l.itemKey}:${c.sku}`, l.itemKey), scope: "BASE", sellingUnitCents: cents(c.unitPriceExVat), mapping: { status: "MAPPED" } });
    }
    const unresolved = comps.filter((c) => !priced.includes(c));
    if (priced.length === 0 || unresolved.length > 0) {
      const why = comps.length === 0
        ? `${l.label} has no Cin7 SKU in the quotation (priced ${l.pricedBy === "penning_rate" ? "per running metre" : "by the estimator"}).`
        : `${unresolved.length} component(s) of ${l.label} have no authoritative SKU or quantity (for example: ${unresolved.map((c) => c.description).slice(0, 3).join("; ")}${unresolved.length > 3 ? "; ..." : ""}).`;
      out.push({ id: `${l.itemKey}:UNMAPPED`, sku: null, description: priced.length ? `${l.label} (remaining components)` : l.label, quantity: l.quantity, unit: "each", productType: "FINISHED_GOOD", origin: origin(`${l.itemKey}:UNMAPPED`, comps.length ? l.itemKey : null), scope: "BASE", sellingUnitCents: priced.length ? null : cents(l.unitPriceExVat), mapping: { status: "UNMAPPED", reason: why } });
    }
  }
  return out;
}
