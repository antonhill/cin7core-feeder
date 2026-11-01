import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { allocateCents, fromCents, scaleCents, toCents, type Cents } from "./money";

/**
 * Scenario C landed cost, in integer cents.
 *
 *   customs value (actual)    = FOB USD x customs FX
 *   customs value (estimate)  = FOB USD x planning FX
 *   duty                      = the workbook's ZAR duty amount, or (optional) a rate x customs value
 *   freight                   = the SHIPMENT's freight, split by CBM share across that shipment's lines ONLY
 *   landed cost (actual)      = customs value (actual) + duty + allocated freight
 *   landed cost (estimate)    = customs value (estimate) + duty (estimate) + allocated freight
 *   FX variance               = actual - estimate
 *
 * Nothing is invented: a missing input leaves the figure null and names the missing field.
 */

export interface LandedConfig {
  /** Duty as a percentage of customs value. null = use the workbook's ZAR duty amounts. */
  readonly dutyRatePct?: number | null;
}

export interface LandedAssumption {
  readonly id: string;
  readonly text: string;
}

export interface LandedLine {
  readonly shipmentRef: string;
  readonly sku: string;
  readonly qty: number;
  readonly cbm: number;
  /** This line's share of the shipment's CBM (0-1), or null when the shipment's CBM is zero. */
  readonly cbmShare: number | null;
  readonly fobUsdCents: Cents | null;
  readonly planningFx: number | null;
  readonly customsFx: number | null;
  readonly customsValueCents: Cents | null;
  readonly planningValueCents: Cents | null;
  readonly dutyCents: Cents | null;
  readonly dutyEstimatedCents: Cents | null;
  readonly dutySource: "workbook duty amount" | "rate on customs value" | null;
  readonly freightCents: Cents | null;
  readonly workbookFreightCents: Cents | null;
  /** workbook allocation - engine allocation (null when the workbook has none). */
  readonly freightDiffCents: Cents | null;
  readonly landedActualCents: Cents | null;
  readonly landedEstimatedCents: Cents | null;
  readonly landedPerUnitActualCents: Cents | null;
  readonly landedPerUnitEstimatedCents: Cents | null;
  readonly fxVarianceCents: Cents | null;
  readonly rateSources: { readonly planning: string; readonly customs: string };
  readonly missing: readonly string[];
  /** complete = the ACTUAL landed cost could be calculated. */
  readonly status: "complete" | "incomplete";
  /** True when the estimate (and so the variance) could also be calculated. */
  readonly comparisonAvailable: boolean;
}

export interface LandedTotals {
  readonly fobUsdCents: Cents;
  readonly customsValueCents: Cents;
  readonly dutyCents: Cents;
  readonly freightCents: Cents;
  readonly landedActualCents: Cents;
  /** null unless every counted line has an estimate. */
  readonly landedEstimatedCents: Cents | null;
  readonly fxVarianceCents: Cents | null;
}

export interface LandedShipment {
  readonly shipmentRef: string;
  readonly lineCount: number;
  readonly totalQty: number;
  readonly totalCbm: number;
  readonly freightTotalCents: Cents | null;
  readonly freightAllocatedCents: Cents;
  readonly complete: boolean;
  /** Present only when every line is complete. */
  readonly totals: LandedTotals | null;
  /** Totals of the complete lines only, for display next to an incomplete shipment. */
  readonly partial: LandedTotals & { readonly lineCount: number };
  readonly warnings: readonly string[];
}

export interface LandedSku {
  readonly sku: string;
  readonly qty: number;
  readonly lineCount: number;
  readonly shipments: readonly string[];
  readonly customsValueCents: Cents;
  readonly dutyCents: Cents;
  readonly freightCents: Cents;
  readonly landedActualCents: Cents;
  readonly landedEstimatedCents: Cents | null;
  readonly fxVarianceCents: Cents | null;
  readonly perUnitActualCents: Cents | null;
  readonly complete: boolean;
}

export interface RateRow {
  readonly shipmentRef: string;
  /** Distinct rates used by this shipment's lines. More than one is worth a look. */
  readonly planning: readonly number[];
  readonly customs: readonly number[];
}

export interface ReconCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface LandedResult {
  readonly config: { readonly dutyRatePct: number | null };
  readonly lines: readonly LandedLine[];
  readonly shipments: readonly LandedShipment[];
  readonly skus: readonly LandedSku[];
  readonly rates: readonly RateRow[];
  readonly totals: LandedTotals & { readonly complete: boolean; readonly lineCount: number };
  readonly checks: readonly ReconCheck[];
  readonly assumptions: readonly LandedAssumption[];
}

/** Duty = rate (percent) x customs value, in cents, rounded half away from zero. */
export function dutyOnCustomsValue(customsValueCents: Cents, ratePct: number): Cents {
  return scaleCents(customsValueCents, ratePct / 100);
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const distinct = (xs: readonly (number | null)[]): number[] => [...new Set(xs.filter((x): x is number => x !== null))].sort((a, b) => a - b);
const perUnit = (cents: Cents, qty: number): Cents => scaleCents(cents, 1 / qty);

function zeroTotals(): LandedTotals {
  return { fobUsdCents: 0, customsValueCents: 0, dutyCents: 0, freightCents: 0, landedActualCents: 0, landedEstimatedCents: 0, fxVarianceCents: 0 };
}

function totalsOf(lines: readonly LandedLine[]): LandedTotals {
  const t = zeroTotals();
  let est: number | null = 0;
  for (const l of lines) {
    (t as { fobUsdCents: number }).fobUsdCents += l.fobUsdCents ?? 0;
    (t as { customsValueCents: number }).customsValueCents += l.customsValueCents ?? 0;
    (t as { dutyCents: number }).dutyCents += l.dutyCents ?? 0;
    (t as { freightCents: number }).freightCents += l.freightCents ?? 0;
    (t as { landedActualCents: number }).landedActualCents += l.landedActualCents ?? 0;
    est = est === null || l.landedEstimatedCents === null ? null : est + l.landedEstimatedCents;
  }
  return { ...t, landedEstimatedCents: est, fxVarianceCents: est === null ? null : t.landedActualCents - est };
}

export function runLandedCost(ds: RwtsaDataset, config: LandedConfig = {}): LandedResult {
  const rate = config.dutyRatePct ?? null;
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) throw new Error("Invalid duty rate: a percentage from 0 to 100.");

  const rows = ds.tables.landedCost;
  const order: string[] = [];
  const byShipment = new Map<string, typeof rows[number][]>();
  for (const r of rows) {
    if (!byShipment.has(r.shipmentRef)) {
      byShipment.set(r.shipmentRef, []);
      order.push(r.shipmentRef);
    }
    (byShipment.get(r.shipmentRef) as typeof rows[number][]).push(r);
  }

  const lines: LandedLine[] = [];
  const shipments: LandedShipment[] = [];
  const rates: RateRow[] = [];

  for (const ref of order) {
    const rs = byShipment.get(ref) as typeof rows[number][];
    const warnings: string[] = [];

    // --- the shipment's freight: one figure for the whole shipment, taken from its rows ---
    const freightSet = [...new Set(rs.map((r) => r.freightTotalZar).filter((f): f is number => f !== null).map(toCents))];
    let freightTotal: Cents | null = null;
    if (freightSet.length === 1) {
      freightTotal = freightSet[0];
      if (rs.some((r) => r.freightTotalZar === null)) warnings.push("Some rows of this shipment have no freight figure; the figure on the other rows is used for the whole shipment.");
    } else if (freightSet.length > 1) {
      warnings.push("The rows of this shipment disagree on the shipment freight, so it is not allocated. Correct the workbook.");
    }

    // --- freight split by CBM share across THIS shipment's lines only ---
    const totalCbm = sum(rs.map((r) => r.cbm));
    let shares: Cents[] | null = null;
    if (freightTotal !== null) {
      shares = allocateCents(freightTotal, rs.map((r) => r.cbm));
      if (shares === null) warnings.push("This shipment has no CBM on any line, so its freight cannot be split by CBM share.");
    }

    const shipLines: LandedLine[] = rs.map((r, i) => {
      const missing: string[] = [];
      const fob = r.fobUsd === null ? null : toCents(r.fobUsd);
      if (fob === null) missing.push("fobUsd");
      if (r.customsFx === null) missing.push("customsFx");
      if (r.planningFx === null) missing.push("planningFx");
      if (rate === null && r.dutyZar === null) missing.push("dutyZar");
      if (freightTotal === null) missing.push("freightTotalZar");
      else if (shares === null) missing.push("cbm");

      const customsValue = fob !== null && r.customsFx !== null ? scaleCents(fob, r.customsFx) : null;
      const planningValue = fob !== null && r.planningFx !== null ? scaleCents(fob, r.planningFx) : null;
      let duty: Cents | null = null;
      let dutyEst: Cents | null = null;
      let dutySource: LandedLine["dutySource"] = null;
      if (rate !== null) {
        dutySource = "rate on customs value";
        duty = customsValue === null ? null : dutyOnCustomsValue(customsValue, rate);
        dutyEst = planningValue === null ? null : dutyOnCustomsValue(planningValue, rate);
      } else if (r.dutyZar !== null) {
        dutySource = "workbook duty amount";
        duty = toCents(r.dutyZar);
        dutyEst = duty;
      }
      const freight = shares === null ? null : shares[i];
      const actual = customsValue !== null && duty !== null && freight !== null ? customsValue + duty + freight : null;
      const est = planningValue !== null && dutyEst !== null && freight !== null ? planningValue + dutyEst + freight : null;
      const wbFreight = r.freightAllocatedZar === null ? null : toCents(r.freightAllocatedZar);
      return {
        shipmentRef: ref,
        sku: r.sku,
        qty: r.qty,
        cbm: r.cbm,
        cbmShare: totalCbm > 0 ? r.cbm / totalCbm : null,
        fobUsdCents: fob,
        planningFx: r.planningFx,
        customsFx: r.customsFx,
        customsValueCents: customsValue,
        planningValueCents: planningValue,
        dutyCents: duty,
        dutyEstimatedCents: dutyEst,
        dutySource,
        freightCents: freight,
        workbookFreightCents: wbFreight,
        freightDiffCents: wbFreight !== null && freight !== null ? wbFreight - freight : null,
        landedActualCents: actual,
        landedEstimatedCents: est,
        landedPerUnitActualCents: actual !== null && r.qty > 0 ? perUnit(actual, r.qty) : null,
        landedPerUnitEstimatedCents: est !== null && r.qty > 0 ? perUnit(est, r.qty) : null,
        fxVarianceCents: actual !== null && est !== null ? actual - est : null,
        rateSources: { planning: "LandedCost.planningFx", customs: "LandedCost.customsFx" },
        missing,
        status: actual !== null ? "complete" : "incomplete",
        comparisonAvailable: actual !== null && est !== null,
      };
    });

    const diffs = shipLines.filter((l) => l.freightDiffCents !== null && l.freightDiffCents !== 0);
    if (diffs.length > 0) warnings.push(`The workbook's own freight allocation differs from the CBM-share allocation on ${diffs.length} line(s); the CBM-share figures are used.`);
    if (shipLines.some((l) => l.status === "incomplete")) warnings.push(`${shipLines.filter((l) => l.status === "incomplete").length} line(s) lack an input, so this shipment's total is withheld.`);

    const complete = shipLines.every((l) => l.status === "complete");
    const done = shipLines.filter((l) => l.status === "complete");
    shipments.push({
      shipmentRef: ref,
      lineCount: shipLines.length,
      totalQty: sum(shipLines.map((l) => l.qty)),
      totalCbm,
      freightTotalCents: freightTotal,
      freightAllocatedCents: sum(shipLines.map((l) => l.freightCents ?? 0)),
      complete,
      totals: complete ? totalsOf(shipLines) : null,
      partial: { ...totalsOf(done), lineCount: done.length },
      warnings,
    });
    rates.push({ shipmentRef: ref, planning: distinct(rs.map((r) => r.planningFx)), customs: distinct(rs.map((r) => r.customsFx)) });
    lines.push(...shipLines);
  }

  // --- SKU view: aggregates lines across shipments; freight is NEVER re-allocated here ---
  const skuOrder: string[] = [];
  const bySku = new Map<string, LandedLine[]>();
  for (const l of lines) {
    if (!bySku.has(l.sku)) {
      bySku.set(l.sku, []);
      skuOrder.push(l.sku);
    }
    (bySku.get(l.sku) as LandedLine[]).push(l);
  }
  const skus: LandedSku[] = skuOrder.map((sku) => {
    const ls = bySku.get(sku) as LandedLine[];
    const done = ls.filter((l) => l.status === "complete");
    const t = totalsOf(done);
    const qtyDone = sum(done.map((l) => l.qty));
    return {
      sku,
      qty: sum(ls.map((l) => l.qty)),
      lineCount: ls.length,
      shipments: [...new Set(ls.map((l) => l.shipmentRef))],
      customsValueCents: t.customsValueCents,
      dutyCents: t.dutyCents,
      freightCents: t.freightCents,
      landedActualCents: t.landedActualCents,
      landedEstimatedCents: t.landedEstimatedCents,
      fxVarianceCents: t.fxVarianceCents,
      perUnitActualCents: done.length > 0 && qtyDone > 0 ? perUnit(t.landedActualCents, qtyDone) : null,
      complete: done.length === ls.length,
    };
  });

  const complete = lines.length > 0 && lines.every((l) => l.status === "complete");
  const grand = totalsOf(lines.filter((l) => l.status === "complete"));
  const totals = { ...grand, complete, lineCount: lines.length };

  // --- reconciliation ---
  const shipFreightOk = shipments.every((s) => s.freightTotalCents === null || s.freightAllocatedCents === 0 || s.freightAllocatedCents === s.freightTotalCents);
  const linesToShipments = shipments.every((s) => s.partial.landedActualCents === sum(lines.filter((l) => l.shipmentRef === s.shipmentRef).map((l) => l.landedActualCents ?? 0)));
  const shipmentsToTotal = grand.landedActualCents === sum(shipments.map((s) => s.partial.landedActualCents));
  const identity = lines.every((l) => l.landedActualCents === null || l.landedActualCents === (l.customsValueCents ?? 0) + (l.dutyCents ?? 0) + (l.freightCents ?? 0));
  const fxIdentity = lines.every((l) => l.fxVarianceCents === null || l.fxVarianceCents === (l.landedActualCents as number) - (l.landedEstimatedCents as number));
  const wbDiffs = lines.filter((l) => l.freightDiffCents !== null && l.freightDiffCents !== 0).length;
  const incomplete = lines.filter((l) => l.status === "incomplete").length;
  const checks: ReconCheck[] = [
    { id: "freight-shipment", label: "Allocated freight equals each shipment's freight, to the cent", ok: shipFreightOk, detail: shipFreightOk ? "Every shipment reconciles." : "A shipment's allocated freight differs from its freight." },
    { id: "lines-to-shipments", label: "Line landed costs sum to their shipment", ok: linesToShipments, detail: `${shipments.length} shipment(s) checked.` },
    { id: "shipments-to-total", label: "Shipment landed costs sum to the grand total", ok: shipmentsToTotal, detail: `Grand total R${fromCents(grand.landedActualCents).toFixed(2)}.` },
    { id: "landed-identity", label: "Landed cost = customs value + duty + allocated freight, on every line", ok: identity, detail: `${lines.length} line(s) checked.` },
    { id: "fx-identity", label: "FX variance = actual - estimate, on every line", ok: fxIdentity, detail: "Compared where both could be calculated." },
    { id: "workbook-freight", label: "Workbook's own freight allocation agrees with the CBM-share allocation", ok: wbDiffs === 0, detail: wbDiffs === 0 ? "No difference (or the workbook gives none)." : `${wbDiffs} line(s) differ.` },
    { id: "complete", label: "Every line has all the inputs for an actual landed cost", ok: complete || (lines.length === 0 ? false : incomplete === 0), detail: incomplete === 0 ? (lines.length === 0 ? "No LandedCost rows." : "All lines complete.") : `${incomplete} line(s) incomplete.` },
  ];

  const assumptions: LandedAssumption[] = [
    { id: "customs-value", text: "Customs value is taken to be the FOB value converted at the customs FX rate (no separate insurance or uplift). Unconfirmed until the real workbook is inspected." },
    { id: "fob-total", text: "LandedCost.fobUsd is read as the line's total FOB in USD (not a unit price)." },
    rate === null
      ? { id: "duty-source", text: "Duty is the ZAR amount in the workbook, used as given for both the actual and the estimate. The column's meaning is unconfirmed; enter a duty rate to calculate it on customs value instead." }
      : { id: "duty-source", text: `Duty is calculated at ${rate}% of customs value (actual on the customs-FX value, estimate on the planning-FX value). This rate is an assumption entered on screen, not workbook data.` },
    { id: "freight-cbm", text: "The shipment's freight is split by each line's CBM share within that shipment only, in whole cents (largest remainder), so the allocation always sums to the shipment freight." },
    { id: "estimate", text: "The estimate uses the planning FX; the actual uses the customs FX. Freight is the same in both, so the variance is the exchange-rate effect on FOB (and on duty, when duty is a rate)." },
  ];

  return { config: { dutyRatePct: rate }, lines, shipments, skus, rates, totals, checks, assumptions };
}
