// Phase 2 S2: pure report builder. Reads a COMPLETE, identity-VERIFIED snapshot (the caller gates that) and the folded register; makes no network call.
import { assessBond, observeBondMovement, type BondAssessment, type ObservedMovement, type RegisterState } from "./engine";
import type { Snapshot } from "../snapshot";

const maps = (s: Snapshot) => ({
  bondBySku: new Map(s.stock.map((x) => [x.sku, x.bond] as const)),
  nonBondBySku: new Map(s.stock.map((x) => [x.sku, Math.max(0, x.physical - x.bond)] as const)),
  usableBySku: new Map(s.stock.map((x) => [x.sku, x.usable] as const)),
});

export interface BondReport {
  generatedAt: string; snapshotHash: string; snapshotTakenAt: string; previousSnapshotHash: string | null; registerTipHash: string; registerEvents: number;
  statements: string[];
  summary: { skusWithBondStock: number; bondUnits: number; verifiedClearedUnits: number; unverifiedClaimedUnits: number; notClearedSkus: number; eligibleUnits: number; proposedUnits: number; exceptionCount: number; unclearedObservedUnits: number };
  rows: BondAssessment[];
  observed: ObservedMovement[];
}

export function buildBondReport(i: { snapshot: Snapshot; previous?: Snapshot; state: RegisterState; registerTipHash: string; registerEvents: number; generatedAt: string }): BondReport {
  const cur = maps(i.snapshot);
  const rows = assessBond(i.state, { bondBySku: cur.bondBySku, operationalUsableBySku: cur.usableBySku });
  const observed = i.previous ? observeBondMovement(i.state, { bondBySku: maps(i.previous).bondBySku, nonBondBySku: maps(i.previous).nonBondBySku }, { bondBySku: cur.bondBySku, nonBondBySku: cur.nonBondBySku }, { fromSnapshotHash: i.previous.contentHash, toSnapshotHash: i.snapshot.contentHash }) : [];
  const sum = (f: (r: BondAssessment) => number) => rows.reduce((t, r) => t + f(r), 0);
  const withBond = rows.filter((r) => r.bondPhysical > 0);
  return {
    generatedAt: i.generatedAt, snapshotHash: i.snapshot.contentHash, snapshotTakenAt: i.snapshot.takenAt, previousSnapshotHash: i.previous?.contentHash ?? null, registerTipHash: i.registerTipHash, registerEvents: i.registerEvents,
    statements: [
      "Unverified clearance means NOT CLEARED.",
      "A stock transfer, posted customs duty or a freight invoice is never evidence of customs clearance.",
      "Eligible stock is the lesser of physical Bond stock and verified-cleared quantity not yet released.",
      "Proposed transfers are drafts: no Cin7 transaction has been or will be created by this report.",
      "Operational usable is Cin7's own figure; the projection assumes proposals complete and is not a fact.",
    ],
    summary: {
      skusWithBondStock: withBond.length, bondUnits: sum((r) => r.bondPhysical), verifiedClearedUnits: sum((r) => r.verifiedCleared), unverifiedClaimedUnits: sum((r) => r.unverifiedClaimed),
      notClearedSkus: withBond.filter((r) => r.clearanceStatus === "NOT_CLEARED").length, eligibleUnits: sum((r) => r.eligible), proposedUnits: sum((r) => r.activeProposed),
      exceptionCount: rows.reduce((t, r) => t + r.exceptions.length, 0) + observed.reduce((t, o) => t + o.exceptions.length, 0), unclearedObservedUnits: observed.reduce((t, o) => t + o.uncleared, 0),
    },
    rows, observed,
  };
}
