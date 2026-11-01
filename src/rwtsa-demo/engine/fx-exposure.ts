import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { daysBetween, monthOf, parseIsoDate } from "./calendar";
import { fromCents, scaleCents, toCents, type Cents } from "./money";

/**
 * Read-only USD exposure by due date, with a planning / FEC / customs FX comparison per payment. It is a view over the
 * Payments_FEC, ImportPOs and LandedCost tabs. It is NOT a forward-contract register and records nothing.
 *
 * Exposure = USD payments due on or after the as-at date. The workbook has no "paid" flag, so earlier-dated rows are listed
 * separately (paid status unknown) and are not counted as open.
 */

export type ExposureBucket = "month" | "week";

export interface ExposureConfig {
  readonly asOf?: string;
  readonly bucket?: ExposureBucket;
}

export interface PaymentExposure {
  readonly poNo: string;
  readonly supplier: string;
  readonly dueDate: string;
  readonly usdCents: Cents;
  readonly deposit: boolean;
  readonly open: boolean;
  readonly fecRef: string | null;
  readonly lockedRate: number | null;
  /** An FEC reference AND a locked rate. */
  readonly covered: boolean;
  readonly zarAtFecCents: Cents | null;
  readonly zarReportedCents: Cents | null;
  /** workbook ZAR value - USD x locked rate. */
  readonly zarReportedDiffCents: Cents | null;
  readonly shipmentRef: string | null;
  readonly planningFx: number | null;
  readonly customsFx: number | null;
  readonly zarAtPlanningCents: Cents | null;
  readonly zarAtCustomsCents: Cents | null;
  /** FEC value - planning value; positive = the FEC costs more than planned. */
  readonly fecVsPlanningCents: Cents | null;
  readonly fecVsCustomsCents: Cents | null;
  readonly rateNote: string | null;
  readonly rateSources: { readonly fec: string; readonly planning: string; readonly customs: string };
}

export interface ExposureBucketRow {
  readonly key: string;
  readonly usdCents: Cents;
  readonly coveredUsdCents: Cents;
  readonly uncoveredUsdCents: Cents;
  readonly count: number;
}

export interface ExposureResult {
  readonly asOf: string;
  readonly bucket: ExposureBucket;
  readonly rows: readonly PaymentExposure[];
  readonly buckets: readonly ExposureBucketRow[];
  readonly totals: {
    readonly openUsdCents: Cents;
    readonly coveredUsdCents: Cents;
    readonly uncoveredUsdCents: Cents;
    readonly dueBeforeAsAtUsdCents: Cents;
  };
  readonly warnings: readonly string[];
}

export const DEFAULT_AS_AT = "2026-10-31";

export function runFxExposure(ds: RwtsaDataset, config: ExposureConfig = {}): ExposureResult {
  const asOf = config.asOf ?? DEFAULT_AS_AT;
  const bucket = config.bucket ?? "month";
  if (parseIsoDate(asOf) === null) throw new Error("Invalid as-at date: expected a real calendar date as YYYY-MM-DD.");
  if (bucket !== "month" && bucket !== "week") throw new Error("Invalid bucket: month or week.");

  // PO -> shipments (ImportPOs) and shipment -> rates (LandedCost)
  const shipmentsOfPo = new Map<string, Set<string>>();
  for (const p of ds.tables.importPos) {
    if (p.shipmentRef === null || p.shipmentRef === "") continue;
    const s = shipmentsOfPo.get(p.poNo) ?? new Set<string>();
    s.add(p.shipmentRef);
    shipmentsOfPo.set(p.poNo, s);
  }
  const rateSet = (ref: string, key: "planningFx" | "customsFx"): number[] =>
    [...new Set(ds.tables.landedCost.filter((l) => l.shipmentRef === ref).map((l) => l[key]).filter((x): x is number => x !== null))];

  const warnings: string[] = [];
  const rows: PaymentExposure[] = ds.tables.paymentsFec.map((p) => {
    const usd = toCents(p.usdAmount);
    const covered = p.fecRef !== null && p.fecRef !== "" && p.lockedRate !== null;
    const zarFec = p.lockedRate !== null ? scaleCents(usd, p.lockedRate) : null;
    const reported = p.zarValue === null ? null : toCents(p.zarValue);

    let shipmentRef: string | null = null;
    let planning: number | null = null;
    let customs: number | null = null;
    let note: string | null = null;
    const ships = shipmentsOfPo.get(p.poNo);
    if (!ships || ships.size === 0) note = "This PO is not linked to a shipment in ImportPOs, so planning and customs rates cannot be matched.";
    else if (ships.size > 1) note = "This PO is in more than one shipment, so a single planning or customs rate cannot be matched.";
    else {
      shipmentRef = [...ships][0];
      const pl = rateSet(shipmentRef, "planningFx");
      const cu = rateSet(shipmentRef, "customsFx");
      if (pl.length > 1 || cu.length > 1) note = "The shipment's lines use more than one planning or customs rate, so none is matched.";
      else {
        planning = pl[0] ?? null;
        customs = cu[0] ?? null;
        if (planning === null || customs === null) note = "The shipment has no planning or customs rate in LandedCost.";
      }
    }
    const zarPlan = planning === null ? null : scaleCents(usd, planning);
    const zarCust = customs === null ? null : scaleCents(usd, customs);
    return {
      poNo: p.poNo,
      supplier: p.supplier,
      dueDate: p.dueDate,
      usdCents: usd,
      deposit: p.isDeposit === true,
      open: daysBetween(asOf, p.dueDate) >= 0,
      fecRef: p.fecRef,
      lockedRate: p.lockedRate,
      covered,
      zarAtFecCents: zarFec,
      zarReportedCents: reported,
      zarReportedDiffCents: reported !== null && zarFec !== null ? reported - zarFec : null,
      shipmentRef,
      planningFx: planning,
      customsFx: customs,
      zarAtPlanningCents: zarPlan,
      zarAtCustomsCents: zarCust,
      fecVsPlanningCents: zarFec !== null && zarPlan !== null ? zarFec - zarPlan : null,
      fecVsCustomsCents: zarFec !== null && zarCust !== null ? zarFec - zarCust : null,
      rateNote: note,
      rateSources: { fec: "Payments_FEC.lockedRate", planning: "LandedCost.planningFx", customs: "LandedCost.customsFx" },
    };
  });

  const open = rows.filter((r) => r.open);
  const before = rows.filter((r) => !r.open);
  const keyOf = (r: PaymentExposure): { k: string; sort: number } => {
    if (bucket === "month") return { k: monthOf(r.dueDate), sort: Number(monthOf(r.dueDate).replace("-", "")) };
    const w = Math.ceil(daysBetween(asOf, r.dueDate) / 7);
    return { k: `week ${w}`, sort: w };
  };
  const map = new Map<string, ExposureBucketRow & { sort: number }>();
  for (const r of open) {
    const { k, sort } = keyOf(r);
    const b = map.get(k) ?? { key: k, usdCents: 0, coveredUsdCents: 0, uncoveredUsdCents: 0, count: 0, sort };
    map.set(k, { ...b, usdCents: b.usdCents + r.usdCents, coveredUsdCents: b.coveredUsdCents + (r.covered ? r.usdCents : 0), uncoveredUsdCents: b.uncoveredUsdCents + (r.covered ? 0 : r.usdCents), count: b.count + 1 });
  }
  const buckets = [...map.values()].sort((a, b) => a.sort - b.sort).map((b) => ({ key: b.key, usdCents: b.usdCents, coveredUsdCents: b.coveredUsdCents, uncoveredUsdCents: b.uncoveredUsdCents, count: b.count }));

  const sum = (xs: readonly PaymentExposure[]) => xs.reduce((a, r) => a + r.usdCents, 0);
  const totals = {
    openUsdCents: sum(open),
    coveredUsdCents: sum(open.filter((r) => r.covered)),
    uncoveredUsdCents: sum(open.filter((r) => !r.covered)),
    dueBeforeAsAtUsdCents: sum(before),
  };
  if (before.length > 0) warnings.push(`${before.length} payment(s) worth USD ${fromCents(totals.dueBeforeAsAtUsdCents).toFixed(2)} fall due before the as-at date. The workbook has no paid flag, so they are listed but not counted as open exposure.`);
  const diffs = rows.filter((r) => r.zarReportedDiffCents !== null && r.zarReportedDiffCents !== 0).length;
  if (diffs > 0) warnings.push(`The workbook's ZAR value differs from USD x locked rate on ${diffs} payment(s).`);
  const unmatched = rows.filter((r) => r.rateNote !== null).length;
  if (unmatched > 0) warnings.push(`${unmatched} payment(s) could not be matched to a single planning and customs rate; the comparison is withheld for them.`);
  return { asOf, bucket, rows, buckets, totals, warnings };
}
