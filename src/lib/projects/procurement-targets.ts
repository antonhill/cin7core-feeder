// NewQuip PROCUREMENT / COST TARGETS (pure). For each physical SKU of the frozen approved scope: the quantity to buy, what stock Cin7 says exists, the cost the
// estimate ALLOWED (frozen at approval), today's Cin7 latest cost, and - where reliably known - the recognised actual cost. The three are never merged:
// an estimate is never presented as an actual, and a later Cin7 cost never rewrites the approved budget. Unknown stays unknown (null), never zero.
import type { CostEntry, CostEstimate } from "./latest-cost";

export interface TargetPhysicalRow { sku: string; ordered: number | null; onHand: number | null; available: number | null; shortfall: number | null; remainingToDeliver: number | null }
export interface TargetActual { quantity: number; costCents: number }
export interface TargetInput {
  /** The estimate frozen with the approved quotation; null when none was captured before approval. */
  estimate: CostEstimate | null;
  /** The frozen approved scope (so a SKU is listed even if no cost was captured for it). */
  scope: ReadonlyArray<{ sku: string; description: string; quantity: number }>;
  physical: ReadonlyArray<TargetPhysicalRow>;
  /** Today's Cin7 latest costs (a fresh read); a null unit cost = none usable. */
  current: Readonly<Record<string, CostEntry | undefined>> | null;
  /** Recognised cost on invoiced lines, per SKU (null = unreadable / not allowed to see). */
  actual: Readonly<Record<string, TargetActual>> | null;
}

export type ApprovedBasis = "CIN7_LATEST" | "MANUAL_ESTIMATE" | "NOT_CAPTURED";
export interface TargetRow {
  sku: string; description: string; requiredQuantity: number;
  onHand: number | null; available: number | null; ordered: number | null; shortfall: number | null;
  approvedBasis: ApprovedBasis; approvedUnitCostCents: number | null; approvedTotalCostCents: number | null; approvedAt: string | null; approvedReason: string | null; supplier: string | null;
  currentUnitCostCents: number | null; currentReadAt: string | null;
  /** current - approved, per unit and across the required quantity (positive = dearer than the approved budget). Null if either side is unknown. */
  unitVarianceCents: number | null; totalVarianceCents: number | null;
  actualUnitCostCents: number | null; actualQuantity: number | null;
  flags: string[];
}
export interface TargetTotals { approvedTotalCents: number | null; currentTotalCents: number | null; varianceCents: number | null; missingApproved: number; missingCurrent: number }

export function buildProcurementTargets(i: TargetInput): { rows: TargetRow[]; totals: TargetTotals; estimateCaptured: boolean } {
  const est = new Map((i.estimate?.lines ?? []).map((l) => [l.sku, l]));
  const phys = new Map(i.physical.map((p) => [p.sku, p]));
  const bySku = new Map<string, { sku: string; description: string; quantity: number }>();
  for (const l of i.scope) { const e = bySku.get(l.sku); bySku.set(l.sku, e ? { ...e, quantity: e.quantity + l.quantity } : { ...l }); } // a SKU in two packages is one row (no double counting)
  const rows = [...bySku.values()].map((l): TargetRow => {
    const e = est.get(l.sku);
    const known = !!e && e.unitCostCents !== null;
    const p = phys.get(l.sku);
    const cur = i.current ? i.current[l.sku] : undefined;
    const currentUnit = cur && cur.unitCostCents !== null && cur.unitCostCents > 0 ? cur.unitCostCents : null;
    const approvedUnit = known ? e!.unitCostCents : null;
    const act = i.actual ? i.actual[l.sku] : undefined;
    const flags: string[] = [];
    if (!i.estimate) flags.push("No cost estimate was captured before this quotation was approved.");
    else if (!known) flags.push("The approved estimate had no cost for this SKU.");
    if (i.current && currentUnit === null) flags.push("Cin7 holds no usable latest cost today.");
    if (!p || p.available === null) flags.push("Stock was not read from Cin7.");
    return {
      sku: l.sku, description: l.description, requiredQuantity: l.quantity,
      onHand: p?.onHand ?? null, available: p?.available ?? null, ordered: p?.ordered ?? null,
      // shortfall: what must still be bought or made against free stock; falls back to required - available when no Sale reports it
      shortfall: p ? (p.shortfall ?? (p.available !== null ? Math.max(0, l.quantity - p.available) : null)) : null,
      approvedBasis: !known ? "NOT_CAPTURED" : e!.status === "MANUAL" ? "MANUAL_ESTIMATE" : "CIN7_LATEST",
      approvedUnitCostCents: approvedUnit, approvedTotalCostCents: known ? e!.totalCostCents : null, approvedAt: known ? e!.retrievedAt : null, approvedReason: known ? e!.reason : null, supplier: known ? e!.supplier : null,
      currentUnitCostCents: currentUnit, currentReadAt: cur?.retrievedAt ?? null,
      unitVarianceCents: currentUnit !== null && approvedUnit !== null ? currentUnit - approvedUnit : null,
      totalVarianceCents: currentUnit !== null && approvedUnit !== null ? Math.round((currentUnit - approvedUnit) * l.quantity) : null,
      actualUnitCostCents: act && act.quantity > 0 ? Math.round(act.costCents / act.quantity) : null, actualQuantity: act ? act.quantity : null,
      flags,
    };
  });
  const sum = (xs: Array<number | null>) => (xs.length && xs.every((x) => x !== null) ? xs.reduce<number>((n, x) => n + (x as number), 0) : null);
  const approvedTotal = sum(rows.map((r) => r.approvedTotalCostCents));
  const currentTotal = sum(rows.map((r) => (r.currentUnitCostCents === null ? null : Math.round(r.currentUnitCostCents * r.requiredQuantity))));
  return {
    rows, estimateCaptured: !!i.estimate,
    totals: { approvedTotalCents: approvedTotal, currentTotalCents: currentTotal, varianceCents: approvedTotal !== null && currentTotal !== null ? currentTotal - approvedTotal : null,
      missingApproved: rows.filter((r) => r.approvedUnitCostCents === null).length, missingCurrent: rows.filter((r) => r.currentUnitCostCents === null).length },
  };
}
