import type { BridgeLine, BudgetQuote } from "../grower/quote-bridge";
import type { GrowerItemKey } from "../grower/types";

// INTERNAL MARGIN SHEET - product, assembly/package, section and project margins, in integer cents, ex VAT.
//
// Margins are an INTERNAL, derived view of the evaluated quote. They are never part of anything a customer sees (the customer summary
// is built separately) and never part of the Project baseline. They are frozen into the accepted quote baseline at manager approval, so a
// later price or cost change cannot rewrite what was agreed. Cin7's zero-priced physical lines never feed this: selling price comes
// from the quote, cost from the price source or an audited estimator override.
//
//   gross profit  = selling - cost
//   gross margin% = gross profit / selling x 100      (the share of the SELLING price that is profit)
//   markup%       = gross profit / cost x 100         (the share of the COST that is profit) - NOT the same as margin
//
// A missing cost is null, never 0: no margin is shown for a line whose cost is unknown. Cost basis is labelled: PROVISIONAL (price-source /
// seeded POC cost), OVERRIDE (estimator-entered, with a reason and who/when) or VERIFIED (reserved for production attestation).

export type CostBasis = "PROVISIONAL" | "OVERRIDE" | "VERIFIED";

import { marginFigures, type MarginFigures } from "@/lib/projects/margin-figures";
export { marginFigures, type MarginFigures };
const toCents = (rands: number | null | undefined): number | null => (rands == null || !Number.isFinite(rands) ? null : Math.round(rands * 100));

// ── manufactured assembly cost ──────────────────────────────────────────────

export interface AssemblyComponentCost { sku: string; quantity: number; unitCostCents: number | null }
export interface AssemblyCostInput {
  sku: string;
  components: AssemblyComponentCost[];
  /** Assembly labour / service cost per assembled unit. */
  labourCents: number;
  /** Freight and landed costs per assembled unit not already in the component costs. */
  freightCents: number;
  /** Other directly attributable manufacturing cost per assembled unit. */
  otherCents: number;
}
export type AssemblyCost = { ok: true; unitCostCents: number; componentCents: number } | { ok: false; error: string };

/** Estimated unit cost of an assembly = BOM components + labour/service + freight/landed + other direct cost. Unknown component cost fails closed. */
export function assemblyUnitCost(i: AssemblyCostInput): AssemblyCost {
  if (i.components.length === 0) return { ok: false, error: `Assembly ${i.sku} has no BOM components.` };
  let comp = 0;
  for (const c of i.components) {
    if (!Number.isFinite(c.quantity) || c.quantity <= 0) return { ok: false, error: `${c.sku}: the BOM quantity must be positive.` };
    if (c.unitCostCents === null || !Number.isFinite(c.unitCostCents) || c.unitCostCents < 0) return { ok: false, error: `${c.sku} has no cost, so the cost of ${i.sku} cannot be estimated.` };
    comp += Math.round(c.quantity * c.unitCostCents);
  }
  for (const [k, v] of [["labour", i.labourCents], ["freight", i.freightCents], ["other", i.otherCents]] as const) {
    if (!Number.isInteger(v) || v < 0) return { ok: false, error: `Assembly ${k} cost must be a whole, non-negative number of cents.` };
  }
  return { ok: true, componentCents: comp, unitCostCents: comp + i.labourCents + i.freightCents + i.otherCents };
}

// ── audited estimator cost override ─────────────────────────────────────────

export interface CostOverride {
  /** Total cost for the whole line (quantity x unit), ex VAT, whole cents. */
  lineCostCents: number;
  reason: string;
  by: string;
  at: string;
}

export function validateCostOverride(o: CostOverride): string | null {
  if (!Number.isInteger(o.lineCostCents) || o.lineCostCents < 0) return "An overridden cost must be a whole, non-negative number of cents.";
  if (!o.reason.trim()) return "A cost override needs a reason.";
  if (!o.by.trim() || !o.at.trim()) return "A cost override must record who made it and when.";
  return null;
}

// ── the sheet ───────────────────────────────────────────────────────────────

export interface MarginLine extends MarginFigures {
  itemKey: string;
  label: string;
  /** The Cin7 SKU sold on this line (null for packages / estimator-priced lines) and its quantity - ties a margin line to the physical scope. */
  sku?: string | null;
  quantity?: number | null;
  kind: "PRODUCT" | "ASSEMBLY_PACKAGE";
  section: string;
  costBasis: CostBasis | null;
  overrideReason?: string;
  components?: Array<MarginFigures & { sku: string | null; description: string; quantity?: number | null; costBasis: CostBasis | null }>;
}
export interface MarginSection extends MarginFigures { section: string; lineCount: number; incomplete: boolean }
export interface MarginSheet {
  /** What the cost figures are, so a partial or provisional margin is never mistaken for a verified one. */
  reportingBasis: string;
  costPolicy: string;
  lines: MarginLine[];
  sections: MarginSection[];
  /** Margin of the COSTED scope. Null cost when ANY costed-in line is missing its cost: a partial total is never presented as the project margin. `uncostedChargesCents` (services without a cost) are outside it; `contractSellingCents` is the whole contract. */
  project: MarginFigures & { incomplete: boolean; missingCostLines: string[]; uncostedChargesCents: number; contractSellingCents: number };
}

const SECTION_BY_ITEM: Record<string, string> = {
  feeder: "Feeding", flex_auger: "Feeding", feed_saver_mat: "Feeding", bulk_tank: "Feeding",
  cup_drinker: "Drinking", concrete_slat: "Flooring", led_light: "Lighting",
  delivery: "Delivery & installation", installation: "Delivery & installation", concrete_slat_delivery: "Delivery & installation",
};
export const sectionOf = (itemKey: string): string => SECTION_BY_ITEM[itemKey] ?? "Other equipment";

/**
 * Builds the sheet from an evaluated budget (which must have been evaluated with cost VISIBLE). Only priced lines are included; a line
 * without a known cost keeps its selling value and shows no margin. Estimator cost overrides replace a line's cost and label it OVERRIDE.
 */
export function buildMarginSheet(b: BudgetQuote, overrides: Partial<Record<GrowerItemKey, CostOverride>> = {}): MarginSheet {
  const lines: MarginLine[] = [];
  for (const l of b.lines.filter((x: BridgeLine) => x.status === "priced")) {
    const selling = toCents(l.revenueExTax) ?? 0;
    const ov = overrides[l.itemKey];
    const ovErr = ov ? validateCostOverride(ov) : null;
    if (ovErr) throw new Error(`${l.label}: ${ovErr}`);
    const planned = ov ? ov.lineCostCents : toCents(l.estimatedCost);
    lines.push({
      itemKey: l.itemKey, label: l.label, sku: l.sku, quantity: l.quantity, kind: l.components ? "ASSEMBLY_PACKAGE" : "PRODUCT", section: sectionOf(l.itemKey),
      ...marginFigures(selling, planned),
      costBasis: planned === null ? null : ov ? "OVERRIDE" : "PROVISIONAL",
      ...(ov ? { overrideReason: ov.reason.trim() } : {}),
      ...(l.components ? {
        components: l.components.filter((c) => c.status === "priced").map((c) => ({
          sku: c.sku, description: c.description, quantity: c.quantity, ...marginFigures(toCents(c.revenueExTax) ?? 0, toCents(c.estimatedCost)),
          costBasis: toCents(c.estimatedCost) === null ? null : ("PROVISIONAL" as const),
        })),
      } : {}),
    });
  }
  // Estimator charges (delivery, installation, slat delivery) are uncosted by design (the engine excludes them from margin). They stay OUT
  // of the margin unless the estimator records an audited cost override for them; their selling value is reported separately so the
  // contract total is still reconciled.
  let uncostedChargesCents = 0;
  for (const c of b.charges.filter((x) => x.amountExTax != null && x.amountExTax > 0)) {
    const ov = overrides[c.key as unknown as GrowerItemKey];
    const sell = toCents(c.amountExTax) ?? 0;
    if (!ov) { uncostedChargesCents += sell; continue; }
    const err = validateCostOverride(ov);
    if (err) throw new Error(`${c.label}: ${err}`);
    lines.push({ itemKey: c.key, label: c.label, kind: "PRODUCT", section: sectionOf(c.key), ...marginFigures(sell, ov.lineCostCents), costBasis: "OVERRIDE", overrideReason: ov.reason.trim() });
  }

  const bySection = new Map<string, MarginLine[]>();
  for (const l of lines) bySection.set(l.section, [...(bySection.get(l.section) ?? []), l]);
  const roll = (ls: MarginLine[]): MarginFigures & { incomplete: boolean } => {
    const selling = ls.reduce((n, l) => n + l.sellingCents, 0);
    const incomplete = ls.some((l) => l.costCents === null);
    return { ...marginFigures(selling, incomplete ? null : ls.reduce((n, l) => n + (l.costCents as number), 0)), incomplete };
  };
  const sections: MarginSection[] = [...bySection.entries()].map(([section, ls]) => { const r = roll(ls); return { section, lineCount: ls.length, ...r }; });
  const all = roll(lines);
  return {
    reportingBasis: `Estimated at quote time from ${b.priceSource.label} (${b.pricingBasis}); excluding VAT. Costs are PROVISIONAL POC figures unless labelled OVERRIDE; not verified actual costs.`,
    costPolicy: "A line with no known cost shows no margin; a section or project total with any missing cost shows no margin rather than a partial one.",
    lines, sections,
    project: { ...all, missingCostLines: lines.filter((l) => l.costCents === null).map((l) => l.label), uncostedChargesCents, contractSellingCents: all.sellingCents + uncostedChargesCents },
  };
}

// ── audit stamping of estimator cost overrides (server-side) ────────────────

type OverrideMap = Partial<Record<string, CostOverride>>;

/**
 * Normalises the cost overrides arriving with a saved draft. who/when are stamped HERE, never trusted from the browser: an override that is
 * unchanged from the stored one keeps its original stamp; a new or changed one is stamped with the saving user and time. A viewer who may
 * not see cost can neither add, change nor remove overrides - the stored ones are kept. Invalid overrides are refused.
 */
export function stampCostOverrides<D extends { estimator: { costOverrides?: OverrideMap } }>(
  draft: D, prior: OverrideMap | undefined, canSeeCost: boolean, email: string, nowIso: string,
): D {
  const next = structuredClone(draft);
  if (!canSeeCost) {
    if (prior && Object.keys(prior).length) next.estimator.costOverrides = structuredClone(prior); else delete next.estimator.costOverrides;
    return next;
  }
  const out: OverrideMap = {};
  for (const [k, o] of Object.entries(draft.estimator.costOverrides ?? {})) {
    if (!o) continue;
    const before = prior?.[k];
    const same = before && before.lineCostCents === o.lineCostCents && before.reason.trim() === o.reason.trim();
    const stamped: CostOverride = same ? before : { lineCostCents: o.lineCostCents, reason: o.reason.trim(), by: email, at: nowIso };
    const err = validateCostOverride(stamped);
    if (err) throw new Error(`Cost override for ${k}: ${err}`);
    out[k] = stamped;
  }
  if (Object.keys(out).length) next.estimator.costOverrides = out as D["estimator"]["costOverrides"]; else delete next.estimator.costOverrides;
  return next;
}

/** The captured physical costs are written only by the server's capture actions: whatever a saved draft carries is replaced with the stored ones. */
export function keepServerOwnedCosts<D extends { estimator: { physicalCosts?: unknown } }>(draft: D, prior: unknown): D {
  const next = structuredClone(draft);
  if (prior && typeof prior === "object" && Object.keys(prior as object).length) next.estimator.physicalCosts = structuredClone(prior); else delete next.estimator.physicalCosts;
  return next;
}

/** The cost-basis declarations (unit basis, accepted exception) are likewise written only by the server's cost actions. */
export function keepServerOwnedCostBasis<D extends { estimator: { costBasis?: unknown } }>(draft: D, prior: unknown): D {
  const next = structuredClone(draft);
  if (prior && typeof prior === "object" && Object.keys(prior as object).length) next.estimator.costBasis = structuredClone(prior); else delete next.estimator.costBasis;
  return next;
}

/** Removes every internal financial from a quote record for a viewer who may not see cost: the frozen margin sheet and the cost overrides. */
export function redactInternalFinancials<Q extends { draft: { estimator: { costOverrides?: unknown; physicalCosts?: unknown; costBasis?: unknown } }; accepted_baseline: { internalMargin?: unknown; physicalCostEstimate?: unknown; estimator?: { physicalCosts?: unknown; costOverrides?: unknown; costBasis?: unknown } } | null }>(quote: Q, canViewCommercials: boolean): Q {
  if (canViewCommercials) return quote;
  const q = structuredClone(quote);
  delete q.draft.estimator.costOverrides;
  delete q.draft.estimator.physicalCosts;
  delete q.draft.estimator.costBasis;
  if (q.accepted_baseline) { delete q.accepted_baseline.internalMargin; delete q.accepted_baseline.physicalCostEstimate; if (q.accepted_baseline.estimator) { delete q.accepted_baseline.estimator.physicalCosts; delete q.accepted_baseline.estimator.costOverrides; delete q.accepted_baseline.estimator.costBasis; } }
  return q;
}
