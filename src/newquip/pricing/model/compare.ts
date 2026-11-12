import type { MarginFigures } from "@/lib/projects/margin-figures";
import type { CalculatedLine, PricingResult, RateUsed } from "./calculate";

// ORIGINAL VERSUS REVISED. Pure. Both sides are ordinary results (normally the original is sealed); nothing is recalculated here: every figure is read from the two results.
// Carries cost, markup and margin: INTERNAL ONLY (see access.ts).

export interface SideFigures { quantity: number | null; unitPriceCents: number | null; revenueCents: number | null; costCents: number | null; status: string }
export interface LineComparison {
  key: string; label: string;
  original: SideFigures | null; revised: SideFigures | null;
  /** revised - original revenue, an unpriced side counting as nothing toward the total. */
  deltaRevenueCents: number;
  changed: boolean;
  /** Why it differs: the recorded override reasons, or the stated basis change. "No reason recorded" only when nothing explains it. */
  reasons: string[];
}
export interface TotalsFigures { totalExVatCents: number; costCents: number | null; margin: MarginFigures | null; completeness: PricingResult["completeness"] }
export interface PricingComparison {
  original: TotalsFigures; revised: TotalsFigures;
  deltaTotalCents: number;
  /** Percentage-point movement, null when either side is unknown. */
  deltaMarginPctPoints: number | null; deltaMarkupPctPoints: number | null;
  lines: LineComparison[];
  /** Differences in the calculation basis itself. */
  basisChanges: string[];
}

const side = (l: CalculatedLine | undefined): SideFigures | null => (l ? { quantity: l.quantity, unitPriceCents: l.unitPriceCents, revenueCents: l.revenueCents, costCents: l.costCents, status: l.status } : null);
const same = (a: SideFigures | null, b: SideFigures | null): boolean => !!a && !!b && a.status === b.status && a.quantity === b.quantity && a.unitPriceCents === b.unitPriceCents && a.revenueCents === b.revenueCents && a.costCents === b.costCents;
const totals = (r: PricingResult): TotalsFigures => ({ totalExVatCents: r.totalExVatCents, costCents: r.itemsCostCents, margin: r.margin, completeness: r.completeness });
const pts = (a: number | null | undefined, b: number | null | undefined): number | null => (a == null || b == null ? null : Math.round((b - a) * 100) / 100);
const rateText = (r: RateUsed): string => `${r.currency} ${r.kind === "forward_cover" ? `forward cover (${r.coverDays} days)` : r.kind} ${(r.rateMicro / 1e6).toFixed(4)}`;

function reasonsFor(o: CalculatedLine | undefined, r: CalculatedLine | undefined, basis: string[]): string[] {
  const out: string[] = [];
  if (r?.override?.price) out.push(`Price override: ${r.override.price.reason}`);
  if (r?.override?.quantity) out.push(`Quantity override: ${r.override.quantity.reason}`);
  if (!r) out.push("Removed from the quotation");
  else if (!o) out.push("Added to the quotation");
  if (out.length === 0) out.push(...basis);
  return out.length ? out : ["No reason recorded"];
}

export function comparePricing(original: PricingResult, revised: PricingResult): PricingComparison {
  const basisChanges: string[] = [];
  if (original.ruleVersion.id !== revised.ruleVersion.id) basisChanges.push(`Pricing rules: ${original.ruleVersion.id} -> ${revised.ruleVersion.id}`);
  if (original.markup.bps !== revised.markup.bps) basisChanges.push(`Project markup: ${original.markup.bps / 100}% -> ${revised.markup.bps / 100}%`);
  const rates = (r: PricingResult) => new Map(r.ratesUsed.map((x) => [x.currency, x]));
  const ro = rates(original), rr = rates(revised);
  for (const cur of [...new Set([...ro.keys(), ...rr.keys()])].sort()) {
    const a = ro.get(cur), b = rr.get(cur);
    if (a && b && (a.rateMicro !== b.rateMicro || a.kind !== b.kind)) basisChanges.push(`Exchange rate: ${rateText(a)} -> ${rateText(b)}`);
  }
  if (revised.adjustment?.applied && !original.adjustment?.applied) basisChanges.push(`Project price adjustment: ${revised.adjustment.reason}`);

  const oMap = new Map(original.lines.map((l) => [l.key, l])), rMap = new Map(revised.lines.map((l) => [l.key, l]));
  const lines: LineComparison[] = [...new Set([...oMap.keys(), ...rMap.keys()])].map((key) => {
    const o = oMap.get(key), r = rMap.get(key);
    const os = side(o), rs = side(r);
    const changed = !same(os, rs);
    return { key, label: (r ?? o)!.label, original: os, revised: rs, deltaRevenueCents: (rs?.revenueCents ?? 0) - (os?.revenueCents ?? 0), changed, reasons: changed ? reasonsFor(o, r, basisChanges) : [] };
  });
  return {
    original: totals(original), revised: totals(revised),
    deltaTotalCents: revised.totalExVatCents - original.totalExVatCents,
    deltaMarginPctPoints: pts(original.margin?.marginPct, revised.margin?.marginPct),
    deltaMarkupPctPoints: pts(original.margin?.markupPct, revised.margin?.markupPct),
    lines, basisChanges,
  };
}
