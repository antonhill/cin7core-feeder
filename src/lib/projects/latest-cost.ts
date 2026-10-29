// NewQuip physical-SKU COST SOURCE for the POC (owner decision): Cin7 LATEST COST, with no cost hierarchy. Pure.
//
//  * "Latest cost" is the cost of the Cin7 product-supplier record that was supplied most recently (Cin7 fills a supplier's cost from each purchase).
//  * No reliable latest cost = MISSING. Never zero, never a silent fallback to average or fixed cost. An authorised, audited MANUAL ESTIMATE (with a reason)
//    may stand in; anything affected is flagged INCOMPLETE until every SKU has a defensible cost.
//  * The estimate is frozen with the approved quotation; later Cin7 cost changes never rewrite it. An estimated cost is never presented as an actual cost.
import { marginFigures, type MarginFigures } from "./margin-figures";

export interface SupplierCostRead { supplier: string | null; /** Currency units (e.g. rand) as Cin7 reports them. */ cost: number | null; fixedCost: number | null; lastSupplied: string | null }
export type LatestCost =
  | { status: "LATEST"; unitCostCents: number; supplier: string | null; lastSupplied: string | null; suppliersConsidered: number }
  | { status: "MISSING"; reason: string };

const cents = (n: number): number => Math.round(n * 100);

/** The latest cost among a product's supplier records. Ambiguity is MISSING (named), not a guess. */
export function resolveLatestCost(suppliers: readonly SupplierCostRead[]): LatestCost {
  const usable = suppliers.filter((s) => typeof s.cost === "number" && Number.isFinite(s.cost) && s.cost > 0);
  if (usable.length === 0) return { status: "MISSING", reason: suppliers.length === 0 ? "The product has no supplier record, so Cin7 holds no latest cost." : "No supplier record carries a latest cost yet (no purchase has set one)." };
  if (usable.length === 1) { const u = usable[0]; return { status: "LATEST", unitCostCents: cents(u.cost!), supplier: u.supplier, lastSupplied: u.lastSupplied, suppliersConsidered: 1 }; }
  const dated = usable.filter((s) => !!s.lastSupplied);
  if (dated.length > 0) {
    const newest = dated.reduce((a, b) => (new Date(b.lastSupplied!).getTime() > new Date(a.lastSupplied!).getTime() ? b : a));
    const tie = dated.filter((s) => new Date(s.lastSupplied!).getTime() === new Date(newest.lastSupplied!).getTime() && cents(s.cost!) !== cents(newest.cost!));
    if (tie.length === 0) return { status: "LATEST", unitCostCents: cents(newest.cost!), supplier: newest.supplier, lastSupplied: newest.lastSupplied, suppliersConsidered: usable.length };
    return { status: "MISSING", reason: "Several suppliers were supplied on the same date at different costs, so the latest cost is ambiguous." };
  }
  const distinct = new Set(usable.map((s) => cents(s.cost!)));
  if (distinct.size === 1) return { status: "LATEST", unitCostCents: [...distinct][0], supplier: usable[0].supplier, lastSupplied: null, suppliersConsidered: usable.length };
  return { status: "MISSING", reason: "Several suppliers have different costs and none has a purchase date, so the latest cost is ambiguous." };
}

export type CostSource = "CIN7_LATEST" | "MANUAL_ESTIMATE";
/** One SKU's cost as captured at estimation (server-owned: a client can never write a CIN7_LATEST entry). */
export interface CostEntry {
  unitCostCents: number | null; source: CostSource; retrievedAt: string; supplier?: string | null; lastSupplied?: string | null;
  /** MANUAL_ESTIMATE only: why, and who/when. */
  reason?: string; by?: string; at?: string;
}

export interface ScopeCostLine { sku: string; description: string; quantity: number }
export interface EstimateLine extends ScopeCostLine {
  status: "LATEST" | "MANUAL" | "MISSING"; unitCostCents: number | null; totalCostCents: number | null; source: CostSource | null; retrievedAt: string | null;
  supplier: string | null; reason: string | null;
}
export interface CostEstimate { lines: EstimateLine[]; totalCostCents: number; missingSkus: string[]; /** Packages with no Cin7 SKU mapping yet: their physical cost cannot be estimated, so the estimate is incomplete. */ unresolvedPackages: string[]; incomplete: boolean }

/** Applies captured costs to the (frozen) physical quantities. A SKU with no usable cost is MISSING and its cost is NOT counted as zero in a total that claims completeness. */
export function buildCostEstimate(scope: readonly ScopeCostLine[], costs: Readonly<Record<string, CostEntry | undefined>>, unresolvedPackages: readonly string[] = []): CostEstimate {
  const merged = new Map<string, ScopeCostLine>();
  for (const l of scope) { const e = merged.get(l.sku); merged.set(l.sku, e ? { ...e, quantity: e.quantity + l.quantity } : { ...l }); } // a SKU in several packages is counted once, quantities added
  const lines = [...merged.values()].map((l): EstimateLine => {
    const c = costs[l.sku];
    const known = !!c && c.unitCostCents !== null && Number.isFinite(c.unitCostCents) && c.unitCostCents >= 0 && !(c.source === "CIN7_LATEST" && c.unitCostCents <= 0);
    if (!known || !c) return { ...l, status: "MISSING", unitCostCents: null, totalCostCents: null, source: c?.source ?? null, retrievedAt: c?.retrievedAt ?? null, supplier: null, reason: null };
    return { ...l, status: c.source === "MANUAL_ESTIMATE" ? "MANUAL" : "LATEST", unitCostCents: c.unitCostCents, totalCostCents: Math.round(l.quantity * c.unitCostCents!), source: c.source, retrievedAt: c.retrievedAt, supplier: c.supplier ?? null, reason: c.reason ?? null };
  });
  const missingSkus = lines.filter((l) => l.status === "MISSING").map((l) => l.sku);
  return { lines, totalCostCents: lines.reduce((n, l) => n + (l.totalCostCents ?? 0), 0), missingSkus, unresolvedPackages: [...unresolvedPackages], incomplete: missingSkus.length > 0 || unresolvedPackages.length > 0 };
}

/** Margin on the physical cost estimate. Null while ANY SKU lacks a cost: a partial total is never presented as the margin. */
export function physicalMargin(contractExVatCents: number, e: CostEstimate): (MarginFigures & { complete: true }) | { complete: false; missing: number; unresolved: number; knownCostCents: number } {
  if (e.incomplete) return { complete: false, missing: e.missingSkus.length, unresolved: e.unresolvedPackages.length, knownCostCents: e.totalCostCents };
  return { ...marginFigures(contractExVatCents, e.totalCostCents), complete: true };
}

/** A manual estimate needs a positive cost and a real reason. */
export function validateManualEstimate(unitCostCents: number, reason: string): string | null {
  if (!Number.isInteger(unitCostCents) || unitCostCents <= 0) return "Enter a cost greater than zero.";
  if (reason.trim().length < 5) return "A manual cost estimate needs a reason (at least a few words).";
  return null;
}
