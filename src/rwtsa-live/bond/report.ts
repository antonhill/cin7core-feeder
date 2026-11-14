// Phase 2 S2: pure report builder. Reads a COMPLETE, identity-VERIFIED snapshot (the caller gates that) and the folded register; makes no network call.
import { assessBond, observeBondMovement, type BondAssessment, type ObservedMovement, type RegisterState } from "./engine";
import type { SkuStock } from "../snapshot";

/** The part of a snapshot the report needs. A real Snapshot satisfies it; so does the invented data of the synthetic demonstration. */
export interface ReportSnapshot { contentHash: string; takenAt: string; stock: readonly Pick<SkuStock, "sku" | "bond" | "physical" | "usable">[] }
export const BOND_REPORT_SCHEMA_VERSION = 2;
export type BondDataClass = "REAL_CIN7_SNAPSHOT" | "SYNTHETIC_DEMONSTRATION";

const maps = (s: ReportSnapshot) => ({
  bondBySku: new Map(s.stock.map((x) => [x.sku, x.bond] as const)),
  nonBondBySku: new Map(s.stock.map((x) => [x.sku, Math.max(0, x.physical - x.bond)] as const)),
  usableBySku: new Map(s.stock.map((x) => [x.sku, x.usable] as const)),
});

export type EvidenceStatus = "VERIFIED" | "UNVERIFIED_NOT_CLEARED" | "WITHDRAWN";
export interface EvidenceView {
  id: string; shipmentRef: string; clearanceRef: string; clearanceDate: string; attributedTo: string; provenance: string; documentRef?: string; recordedOn: string;
  status: EvidenceStatus; verifiedBy?: string; verifiedOn?: string; verifiedAt?: string; verificationDocumentRef?: string; withdrawnReason?: string;
  lines: { sku: string; quantity: number }[];
}
export interface ProposalView { id: string; sku: string; quantity: number; destination: string; proposedBy: string; proposedOn: string; reason: string; status: "OPEN" | "PARTLY_COMPLETED" | "COMPLETED" | "WITHDRAWN"; completedQuantity: number }
export interface ReleaseView { id: string; sku: string; quantity: number; on: string; fromTakenAt: string; toTakenAt: string; proposalId?: string; voided: boolean; releasedBeforeCoverUnits: number }

export interface BondReport {
  schemaVersion: typeof BOND_REPORT_SCHEMA_VERSION;
  /** REAL_CIN7_SNAPSHOT or SYNTHETIC_DEMONSTRATION. A synthetic report is invented data and is never a real customs event. */
  dataClass: BondDataClass;
  generatedAt: string; snapshotHash: string; snapshotTakenAt: string; previousSnapshotHash: string | null; registerTipHash: string; registerEvents: number;
  statements: string[];
  summary: { skusWithBondStock: number; bondUnits: number; verifiedClearedUnits: number; unverifiedClaimedUnits: number; notClearedSkus: number; eligibleUnits: number; proposedUnits: number; exceptionCount: number; unclearedObservedUnits: number };
  rows: BondAssessment[];
  observed: ObservedMovement[];
  evidence: EvidenceView[];
  proposals: ProposalView[];
  releases: ReleaseView[];
}

export function buildBondReport(i: { snapshot: ReportSnapshot; previous?: ReportSnapshot; state: RegisterState; registerTipHash: string; registerEvents: number; generatedAt: string; dataClass?: BondDataClass; extraStatements?: readonly string[] }): BondReport {
  const cur = maps(i.snapshot);
  const rows = assessBond(i.state, { bondBySku: cur.bondBySku, operationalUsableBySku: cur.usableBySku });
  const observed = i.previous ? observeBondMovement(i.state, { bondBySku: maps(i.previous).bondBySku, nonBondBySku: maps(i.previous).nonBondBySku }, { bondBySku: cur.bondBySku, nonBondBySku: cur.nonBondBySku }, { fromSnapshotHash: i.previous.contentHash, toSnapshotHash: i.snapshot.contentHash, fromTakenAt: i.previous.takenAt }) : [];
  const sum = (f: (r: BondAssessment) => number) => rows.reduce((t, r) => t + f(r), 0);
  const withBond = rows.filter((r) => r.bondPhysical > 0);
  const evidence: EvidenceView[] = [...i.state.entries.values()].map((s) => ({
    id: s.entry.id, shipmentRef: s.entry.shipmentRef, clearanceRef: s.entry.clearanceRef, clearanceDate: s.entry.clearanceDate, attributedTo: s.entry.attributedTo, provenance: s.entry.provenance,
    ...(s.entry.documentRef !== undefined ? { documentRef: s.entry.documentRef } : {}), recordedOn: s.entry.recordedOn,
    status: s.withdrawn ? "WITHDRAWN" : s.verified ? "VERIFIED" : "UNVERIFIED_NOT_CLEARED",
    ...(s.verified ? { verifiedBy: s.verified.by, verifiedOn: s.verified.on, ...(s.verified.at ? { verifiedAt: s.verified.at } : {}), verificationDocumentRef: s.verified.documentRef } : {}),
    ...(s.withdrawn ? { withdrawnReason: s.withdrawn.reason } : {}),
    lines: s.entry.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
  }));
  const proposals: ProposalView[] = [...i.state.proposals.values()].map((p) => ({
    id: p.proposal.id, sku: p.proposal.sku, quantity: p.proposal.quantity, destination: p.proposal.destination, proposedBy: p.proposal.proposedBy, proposedOn: p.proposal.proposedOn, reason: p.proposal.reason,
    status: p.withdrawn ? "WITHDRAWN" : p.completed >= p.proposal.quantity ? "COMPLETED" : p.completed > 0 ? "PARTLY_COMPLETED" : "OPEN", completedQuantity: p.completed,
  }));
  const releases: ReleaseView[] = i.state.releases.map((r) => ({ id: r.id, sku: r.sku, quantity: r.quantity, on: r.on, fromTakenAt: r.fromTakenAt, toTakenAt: r.toTakenAt, ...(r.proposalId ? { proposalId: r.proposalId } : {}), voided: r.voided, releasedBeforeCoverUnits: r.uncovered }));
  return {
    schemaVersion: BOND_REPORT_SCHEMA_VERSION, dataClass: i.dataClass ?? "REAL_CIN7_SNAPSHOT",
    generatedAt: i.generatedAt, snapshotHash: i.snapshot.contentHash, snapshotTakenAt: i.snapshot.takenAt, previousSnapshotHash: i.previous?.contentHash ?? null, registerTipHash: i.registerTipHash, registerEvents: i.registerEvents,
    statements: [
      ...(i.extraStatements ?? []),
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
    rows, observed, evidence, proposals, releases,
  };
}
