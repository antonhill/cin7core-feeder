// Projects - COSTING REPORT dimensions (pure, generic, INTERNAL: cost and margin; only for viewers who may see cost).
//
// Four different cost figures are never merged or assumed equal:
//   ESTIMATED  - frozen at quote / variation approval (the budget);
//   INDICATIVE - today's Cin7 product average cost x scope quantity (a sanity check, not a budget);
//   INCURRED   - Cin7 invoice-line average cost x invoiced quantity (stock) plus incurred non-stock costs (Toolbox ledger);
//   RECOGNISED - cost Cin7 has booked as COGS (reported on the profitability report; may legitimately lag the invoice lines).
// Unknown is null, never zero. Stock costs already inside Cin7 inventory / assembly values are never added again as non-stock costs.

import { marginFigures, type MarginFigures } from "./margin-figures";

export interface EstimateLine {
  itemKey: string; label: string; section: string; sku: string | null;
  sellingCents: number; costCents: number | null;
  /** Cost / selling of each sold component for a package (lets cost be reported by real SKU). */
  components?: Array<{ sku: string | null; description: string; sellingCents: number | null; costCents: number | null }>;
}
export interface ActualSkuCost { quantity: number; costCents: number }
export interface StageInput { name: string; valueCents: number }
export interface NonStockTotals { incurredCents: number; committedCents: number; byCategory: Record<string, { incurredCents: number; committedCents: number }> }

export interface CostingInput {
  /** BASE scope frozen estimate lines (from the accepted quotation's margin sheet); empty/undefined when there is none. */
  base: { contractCents: number; lines: EstimateLine[]; stages: StageInput[]; estimatedCostCents: number | null; uncostedSellingCents: number } | null;
  variations: Array<{ code: string; contractCents: number; estimatedCostCents: number | null }>;
  /** Invoice-line cost by SKU, summed over every scope's Cin7 Sale; null = at least one invoice line is unreadable (unknown, not zero). */
  actualBySku: Record<string, ActualSkuCost> | null;
  /** SKU -> last supplier recorded on the Cin7 product (a "last supplied by" field: informative, not an authoritative cost group). */
  supplierBySku: Record<string, string | null>;
  nonStock: NonStockTotals | null;
  /** Revised contract, ex VAT. */
  revisedContractCents: number;
}

export interface SkuCostRow { sku: string; description: string; section: string; estimatedCents: number | null; actualCents: number | null; actualQuantity: number | null; varianceCents: number | null }
export interface SectionCostRow extends MarginFigures { section: string; lines: number }
export interface StageCostRow { stage: string; valueCents: number; estimatedCostCents: number | null; gpCents: number | null; marginPct: number | null }
export interface SupplierCostRow { supplier: string; estimatedCents: number | null; actualCents: number | null; skus: number }

export interface CostingReport {
  basisNotes: string[];
  bySku: SkuCostRow[];
  bySection: SectionCostRow[];
  /** Estimated cost allocated to stages PRO RATA to stage value: the quotation does not assign cost to billing stages. */
  byStage: StageCostRow[];
  bySupplier: SupplierCostRow[];
  byScope: Array<{ scope: string; contractCents: number; estimatedCostCents: number | null; estimated: MarginFigures }>;
  budget: {
    estimatedStockCostCents: number | null;
    incurredStockCostCents: number | null;
    /** incurred - estimated (positive = over budget); null if either is unknown. */
    stockVarianceCents: number | null;
    nonStockIncurredCents: number | null; nonStockCommittedCents: number | null;
    /** Stock: the larger of estimate and incurred; non-stock: incurred + committed. Null when the estimate is unknown. */
    expectedFinalCostCents: number | null;
    expectedFinalMargin: MarginFigures | null;
    /** FULL_CONTRACT once non-stock costs are recorded (services are then costed); otherwise COSTED_SCOPE_ONLY, which leaves services without a recorded cost out. */
    marginBasis: "FULL_CONTRACT" | "COSTED_SCOPE_ONLY";
  };
}

const sumOrNull = (xs: ReadonlyArray<number | null>): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((n, x) => n + (x as number), 0));

export function buildCostingReport(i: CostingInput): CostingReport {
  const notes = [
    "Estimated = frozen at approval (budget). Incurred = Cin7 invoice-line average cost x invoiced quantity, plus incurred non-stock costs. Cin7-recognised COGS is reported separately and may lag. They are never assumed equal.",
    "Supplier groups use the 'last supplied by' value on the Cin7 product: indicative only, not an authoritative cost group.",
    "Stage figures allocate estimated cost pro rata to stage value, because the quotation does not assign cost to billing stages.",
  ];

  // ── by SKU: estimated from the sold components / lines; actual from the invoice lines ──
  const est = new Map<string, { description: string; section: string; estimatedCents: number | null }>();
  const addEst = (sku: string, description: string, section: string, cost: number | null) => {
    const cur = est.get(sku);
    if (!cur) est.set(sku, { description, section, estimatedCents: cost });
    else cur.estimatedCents = cur.estimatedCents === null || cost === null ? null : cur.estimatedCents + cost;
  };
  for (const l of i.base?.lines ?? []) {
    if (l.components?.length) for (const c of l.components) { if (c.sku) addEst(c.sku, c.description, l.section, c.costCents); }
    else if (l.sku) addEst(l.sku, l.label, l.section, l.costCents);
  }
  const skus = new Set<string>([...est.keys(), ...Object.keys(i.actualBySku ?? {})]);
  const bySku: SkuCostRow[] = [...skus].sort().map((sku) => {
    const e = est.get(sku);
    const a = i.actualBySku === null ? null : i.actualBySku[sku] ?? { quantity: 0, costCents: 0 }; // a SKU with no invoice line yet has incurred nothing (invoice lines were readable)
    const estimatedCents = e ? e.estimatedCents : null;
    return {
      sku, description: e?.description ?? sku, section: e?.section ?? "Other equipment", estimatedCents,
      actualCents: a ? a.costCents : null, actualQuantity: a ? a.quantity : null,
      varianceCents: a && estimatedCents !== null ? a.costCents - estimatedCents : null,
    };
  });

  // ── by section / package ──
  const sections = new Map<string, { selling: number; costs: Array<number | null>; lines: number }>();
  for (const l of i.base?.lines ?? []) {
    const s = sections.get(l.section) ?? { selling: 0, costs: [], lines: 0 };
    s.selling += l.sellingCents; s.costs.push(l.costCents); s.lines += 1; sections.set(l.section, s);
  }
  const bySection: SectionCostRow[] = [...sections].map(([section, s]) => ({ section, lines: s.lines, ...marginFigures(s.selling, sumOrNull(s.costs)) }));

  // ── by stage (pro rata) ──
  const contract = i.base?.contractCents ?? 0;
  const baseCost = i.base?.estimatedCostCents ?? null;
  const costedSelling = contract - (i.base?.uncostedSellingCents ?? 0);
  const byStage: StageCostRow[] = (i.base?.stages ?? []).map((s) => {
    if (baseCost === null || contract <= 0) return { stage: s.name, valueCents: s.valueCents, estimatedCostCents: null, gpCents: null, marginPct: null };
    const cost = Math.round((baseCost * s.valueCents) / contract);
    const sellingForMargin = costedSelling > 0 ? Math.round((costedSelling * s.valueCents) / contract) : 0;
    const m = marginFigures(sellingForMargin, cost);
    return { stage: s.name, valueCents: s.valueCents, estimatedCostCents: cost, gpCents: m.gpCents, marginPct: m.marginPct };
  });

  // ── by supplier (last supplier recorded) ──
  const sup = new Map<string, { est: Array<number | null>; act: Array<number | null>; skus: number }>();
  for (const r of bySku) {
    const name = i.supplierBySku[r.sku] ?? "Supplier not recorded";
    const g = sup.get(name) ?? { est: [], act: [], skus: 0 };
    g.est.push(r.estimatedCents); g.act.push(r.actualCents); g.skus += 1; sup.set(name, g);
  }
  const bySupplier: SupplierCostRow[] = [...sup].map(([supplier, g]) => ({ supplier, estimatedCents: sumOrNull(g.est), actualCents: sumOrNull(g.act), skus: g.skus })).sort((a, b) => (a.supplier < b.supplier ? -1 : 1));

  // ── by scope ──
  const byScope: CostingReport["byScope"] = [];
  if (i.base) byScope.push({ scope: "Original contract", contractCents: i.base.contractCents, estimatedCostCents: baseCost, estimated: marginFigures(costedSelling, baseCost) });
  for (const v of i.variations) byScope.push({ scope: `${v.code} variation`, contractCents: v.contractCents, estimatedCostCents: v.estimatedCostCents, estimated: marginFigures(v.contractCents, v.estimatedCostCents) });

  // ── budget vs actual, expected final margin ──
  const estimatedStock = sumOrNull(byScope.map((s) => s.estimatedCostCents));
  const incurredStock = i.actualBySku === null ? null : Object.values(i.actualBySku).reduce((n, a) => n + a.costCents, 0);
  const nsInc = i.nonStock ? i.nonStock.incurredCents : null;
  const nsCom = i.nonStock ? i.nonStock.committedCents : null;
  const expectedFinal = estimatedStock === null || nsInc === null || nsCom === null ? null : Math.max(estimatedStock, incurredStock ?? 0) + nsInc + nsCom;
  const uncostedAll = (i.base?.uncostedSellingCents ?? 0);
  const servicesCosted = (nsInc ?? 0) + (nsCom ?? 0) > 0;
  return {
    basisNotes: notes, bySku, bySection, byStage, bySupplier, byScope,
    budget: {
      estimatedStockCostCents: estimatedStock, incurredStockCostCents: incurredStock,
      stockVarianceCents: estimatedStock === null || incurredStock === null ? null : incurredStock - estimatedStock,
      nonStockIncurredCents: nsInc, nonStockCommittedCents: nsCom, expectedFinalCostCents: expectedFinal,
      // Services (delivery, installation) have no frozen estimate. Until non-stock costs are recorded their selling value is left out so the margin is not overstated.
      expectedFinalMargin: expectedFinal === null ? null : marginFigures(servicesCosted ? i.revisedContractCents : i.revisedContractCents - uncostedAll, expectedFinal),
      marginBasis: servicesCosted ? "FULL_CONTRACT" : "COSTED_SCOPE_ONLY",
    },
  };
}
