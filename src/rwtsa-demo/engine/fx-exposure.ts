import type { PaymentFecRow } from "@/rwtsa-demo/contracts/tabs";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { daysBetween, monthOf, parseIsoDate } from "./calendar";
import { fromCents, scaleCents, toCents, type Cents } from "./money";

/**
 * Read-only USD payment schedule and exposure by due date, with a planning / FEC / customs FX comparison per payment. It is a
 * view over the Payments_FEC, ImportPOs and LandedCost tabs. It is NOT a forward-contract register and records nothing.
 *
 * SETTLEMENT IS NEVER ASSUMED. A due date before the as-at date is NOT evidence that a payment was made. Each payment is one of:
 *   - "paid":    explicit evidence only: a recognised paid status, a paid date, or a deposit under the documented Rev2 rule below;
 *   - "open":    an explicit open / unpaid status;
 *   - "unknown": everything else (the default). It is counted as POTENTIAL exposure, never as confirmed open and never as paid.
 * Three tiers are kept apart: SCHEDULED (every payment, as the terms were set), POTENTIAL (every payment not confirmed paid) and
 * CONFIRMED OPEN (only payments with explicit open evidence; null, not zero, when there are none).
 *
 * Deposit rule (RWTSA Rev2 clarification, 29 Oct 2026: a 30% deposit "paid at shipment"; RFP DP-23: a deposit-before-production
 * term): a payment flagged as a deposit, or whose remark STARTS with "deposit" without a negation or timing word, AND due on its
 * shipment date with 0 terms is treated as paid. A paid date after the as-at date means the payment was open at the as-at date. Zero terms alone (for example a per-shipment QC cost) is NOT a deposit.
 */

export type ExposureBucket = "month" | "week";
export type Settlement = "paid" | "open" | "unknown";
export type SettlementBasis = "explicit-status" | "paid-date" | "deposit-rev2" | "explicit-open" | "paid-after-as-at" | "none";
export const OVERDUE_BUCKET = "Overdue (due before as-at)";

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
  /** Evidence-based settlement; "unknown" unless the data say otherwise. */
  readonly settlement: Settlement;
  readonly settlementBasis: SettlementBasis;
  /** Due before the as-at date. Informational only: it never changes the settlement or the exposure. */
  readonly pastDue: boolean;
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
  /** Potential exposure in the bucket (every payment not confirmed paid). */
  readonly usdCents: Cents;
  readonly confirmedOpenUsdCents: Cents;
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
    /** Every payment, as scheduled. */
    readonly scheduledUsdCents: Cents;
    /** Confirmed paid (explicit evidence or the Rev2 deposit rule). */
    readonly paidUsdCents: Cents;
    /** Every payment not confirmed paid: confirmed open plus settlement-unknown. */
    readonly potentialUsdCents: Cents;
    readonly potentialCoveredUsdCents: Cents;
    readonly potentialUncoveredUsdCents: Cents;
    /** Settlement unknown. */
    readonly unknownUsdCents: Cents;
    /** Of the unknown ones, those already past their due date. */
    readonly pastDueUnknownUsdCents: Cents;
    /** Only payments with explicit open evidence; null when there are none (never shown as zero). */
    readonly confirmedOpenUsdCents: Cents | null;
    readonly confirmedOpenCoveredUsdCents: Cents | null;
    readonly confirmedOpenUncoveredUsdCents: Cents | null;
    readonly counts: { readonly paid: number; readonly open: number; readonly unknown: number; readonly pastDueUnknown: number };
  };
  readonly warnings: readonly string[];
}

// Optional input conventions (the workbook has no such column): the minimum vocabulary, nothing more. Anything else is "unknown".
const PAID_WORDS = /^paid$/i;
const OPEN_WORDS = /^(open|unpaid)$/i;
// A remark counts as a deposit only when it STARTS with the word and carries no negation or timing word.
const DEPOSIT_REMARK = /^\s*deposit\b(?!.*\b(?:not|no|unpaid|due|after|balance)\b)/i;

interface Classified {
  readonly settlement: Settlement;
  readonly basis: SettlementBasis;
  readonly unrecognised: boolean;
  readonly conflict: boolean;
}

/** Evidence only. Anything that is not explicitly documented stays "unknown". */
function classify(p: PaymentFecRow, asOf: string): Classified {
  const status = p.paymentStatus === null || p.paymentStatus === undefined ? "" : p.paymentStatus.trim();
  const hasPaidDate = p.paidDate !== null && p.paidDate !== undefined && p.paidDate !== "";
  const statusPaid = PAID_WORDS.test(status);
  const statusOpen = OPEN_WORDS.test(status);
  const unrecognised = status !== "" && !statusPaid && !statusOpen;
  // A paid date AFTER the as-at date means the payment was still outstanding at the as-at date.
  if (hasPaidDate && daysBetween(asOf, p.paidDate as string) > 0) return { settlement: "open", basis: "paid-after-as-at", unrecognised, conflict: false };
  if (statusOpen && hasPaidDate) return { settlement: "unknown", basis: "none", unrecognised: false, conflict: true };
  if (statusPaid) return { settlement: "paid", basis: "explicit-status", unrecognised: false, conflict: false };
  if (hasPaidDate) return { settlement: "paid", basis: "paid-date", unrecognised: false, conflict: false };
  if (statusOpen) return { settlement: "open", basis: "explicit-open", unrecognised: false, conflict: false };
  const depositEvidence = p.isDeposit === true || (typeof p.remark === "string" && DEPOSIT_REMARK.test(p.remark));
  // Rev2: the deposit was paid AT SHIPMENT. So the payment must be due on the shipment date itself (0 days, same day).
  const atShipment = p.termsDays === 0 && p.shipmentDate !== null && p.shipmentDate !== undefined && p.shipmentDate === p.dueDate && daysBetween(asOf, p.shipmentDate) <= 0; // not yet shipped at the as-at date: cannot have been paid at shipment
  // An unrecognised status text means someone recorded something we do not understand: not a basis for paid.
  if (depositEvidence && atShipment && status === "") return { settlement: "paid", basis: "deposit-rev2", unrecognised, conflict: false };
  return { settlement: "unknown", basis: "none", unrecognised, conflict: false };
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
  /** Distinct usable rates of a shipment, or null when any of its lines lacks one (a partial set is not trusted). */
  const rateSet = (ref: string, key: "planningFx" | "customsFx"): number[] | null => {
    const vals = ds.tables.landedCost.filter((l) => l.shipmentRef === ref).map((l) => l[key]);
    if (vals.some((x) => x === null || x <= 0)) return null;
    return [...new Set(vals as number[])];
  };

  const warnings: string[] = [];
  let unrecognisedCount = 0;
  let conflictCount = 0;
  let paidLaterCount = 0;
  const rows: PaymentExposure[] = ds.tables.paymentsFec.map((p) => {
    const usd = toCents(p.usdAmount);
    const covered = p.fecRef !== null && p.fecRef !== "" && p.lockedRate !== null;
    // A locked rate without an FEC reference is not cover, so no FEC value is shown for it.
    const zarFec = covered && p.lockedRate !== null ? scaleCents(usd, p.lockedRate) : null;
    const reported = p.zarValue === null ? null : toCents(p.zarValue);
    const cls = classify(p, asOf);
    if (cls.unrecognised) unrecognisedCount++;
    if (cls.conflict) conflictCount++;
    if (cls.basis === "paid-after-as-at") paidLaterCount++;

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
      if (pl === null || cu === null || pl.length === 0 || cu.length === 0) note = "The shipment has no planning or customs rate on one or more LandedCost lines, so none is matched.";
      else if (pl.length > 1 || cu.length > 1) note = "The shipment's lines use more than one planning or customs rate, so none is matched.";
      else {
        planning = pl[0];
        customs = cu[0];
      }
    }
    const zarPlan = planning === null ? null : scaleCents(usd, planning);
    const zarCust = customs === null ? null : scaleCents(usd, customs);
    return {
      poNo: p.poNo,
      supplier: p.supplier,
      dueDate: p.dueDate,
      usdCents: usd,
      deposit: p.isDeposit === true || (typeof p.remark === "string" && DEPOSIT_REMARK.test(p.remark)),
      settlement: cls.settlement,
      settlementBasis: cls.basis,
      pastDue: daysBetween(asOf, p.dueDate) < 0,
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

  const potential = rows.filter((r) => r.settlement !== "paid");
  const paid = rows.filter((r) => r.settlement === "paid");
  const confirmedOpen = rows.filter((r) => r.settlement === "open");
  const unknown = rows.filter((r) => r.settlement === "unknown");
  const pastDueUnknown = unknown.filter((r) => r.pastDue);
  const keyOf = (r: PaymentExposure): { k: string; sort: number } => {
    if (r.pastDue) return { k: OVERDUE_BUCKET, sort: Number.NEGATIVE_INFINITY };
    if (bucket === "month") return { k: monthOf(r.dueDate), sort: Number(monthOf(r.dueDate).replace("-", "")) };
    const w = Math.ceil(daysBetween(asOf, r.dueDate) / 7);
    return { k: `week ${w}`, sort: w };
  };
  const map = new Map<string, ExposureBucketRow & { sort: number }>();
  for (const r of potential) {
    const { k, sort } = keyOf(r);
    const b = map.get(k) ?? { key: k, usdCents: 0, confirmedOpenUsdCents: 0, coveredUsdCents: 0, uncoveredUsdCents: 0, count: 0, sort };
    map.set(k, {
      ...b,
      usdCents: b.usdCents + r.usdCents,
      confirmedOpenUsdCents: b.confirmedOpenUsdCents + (r.settlement === "open" ? r.usdCents : 0),
      coveredUsdCents: b.coveredUsdCents + (r.covered ? r.usdCents : 0),
      uncoveredUsdCents: b.uncoveredUsdCents + (r.covered ? 0 : r.usdCents),
      count: b.count + 1,
    });
  }
  const buckets = [...map.values()].sort((a, b) => a.sort - b.sort).map((b) => ({ key: b.key, usdCents: b.usdCents, confirmedOpenUsdCents: b.confirmedOpenUsdCents, coveredUsdCents: b.coveredUsdCents, uncoveredUsdCents: b.uncoveredUsdCents, count: b.count }));

  const sum = (xs: readonly PaymentExposure[]) => xs.reduce((a, r) => a + r.usdCents, 0);
  const totals = {
    scheduledUsdCents: sum(rows),
    paidUsdCents: sum(paid),
    potentialUsdCents: sum(potential),
    potentialCoveredUsdCents: sum(potential.filter((r) => r.covered)),
    potentialUncoveredUsdCents: sum(potential.filter((r) => !r.covered)),
    unknownUsdCents: sum(unknown),
    pastDueUnknownUsdCents: sum(pastDueUnknown),
    confirmedOpenUsdCents: confirmedOpen.length === 0 ? null : sum(confirmedOpen),
    confirmedOpenCoveredUsdCents: confirmedOpen.length === 0 ? null : sum(confirmedOpen.filter((r) => r.covered)),
    confirmedOpenUncoveredUsdCents: confirmedOpen.length === 0 ? null : sum(confirmedOpen.filter((r) => !r.covered)),
    counts: { paid: paid.length, open: confirmedOpen.length, unknown: unknown.length, pastDueUnknown: pastDueUnknown.length },
  };
  if (unknown.length > 0) warnings.push(`${unknown.length} payment(s) worth USD ${fromCents(totals.unknownUsdCents).toFixed(2)} have no settlement evidence in the workbook. They are counted as potential exposure: not as confirmed open, and not as paid.`);
  if (pastDueUnknown.length > 0) warnings.push(`${pastDueUnknown.length} of them (USD ${fromCents(totals.pastDueUnknownUsdCents).toFixed(2)}) are past their due date. A past due date is not evidence of payment, so they stay in the potential exposure.`);
  const rev2 = rows.filter((r) => r.settlementBasis === "deposit-rev2");
  if (rev2.length > 0) warnings.push(`${rev2.length} deposit payment(s) worth USD ${fromCents(sum(rev2)).toFixed(2)} are treated as paid at shipment under the RWTSA Rev2 clarification (29 Oct 2026): flagged or remarked as a deposit and due on the shipment date (0 days).`);
  if (unrecognisedCount > 0) warnings.push(`${unrecognisedCount} payment(s) have an unrecognised payment status; settlement is unknown for them.`);
  if (conflictCount > 0) warnings.push(`${conflictCount} payment(s) have an open status that conflicts with a paid date on or before the as-at date; settlement is unknown for them.`);
  if (paidLaterCount > 0) warnings.push(`${paidLaterCount} payment(s) have a paid date after the as-at date: they were still open at the as-at date and are counted as confirmed open.`);
  const diffs = rows.filter((r) => r.zarReportedDiffCents !== null && r.zarReportedDiffCents !== 0).length;
  if (diffs > 0) warnings.push(`The workbook's ZAR value differs from USD x locked rate on ${diffs} payment(s).`);
  const lockedNoRef = rows.filter((r) => r.lockedRate !== null && !r.covered).length;
  if (lockedNoRef > 0) warnings.push(`${lockedNoRef} payment(s) have a locked rate but no FEC reference; they are treated as uncovered.`);
  const unmatched = rows.filter((r) => r.rateNote !== null).length;
  if (unmatched > 0) warnings.push(`${unmatched} payment(s) could not be matched to a single planning and customs rate; the comparison is withheld for them.`);
  return { asOf, bucket, rows, buckets, totals, warnings };
}
