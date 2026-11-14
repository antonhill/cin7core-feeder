// Phase 2 S3: a clearly SEPARATE, fully invented demonstration of the Bond controls. Every identifier starts with SYN- / synthetic; nothing here is derived from the real
// RWTSA instance, and a synthetic clearance is never a real customs event. It runs the REAL engine and report builder over invented events, so the demonstration
// exercises the actual rules (recording, verification, eligibility, a proposed transfer, exceptions). No I/O, no clock.
import { foldRegister, type RegisterEvent } from "./engine";
import { buildBondReport, type BondReport, type ReportSnapshot } from "./report";

export const SYNTHETIC_REPORT_FILE_NAME = "bond-report-synthetic.json";
const WHO = "synthetic-owner";
const stock = (rows: Record<string, { bond: number; nonBond: number; usable: number }>): ReportSnapshot["stock"] =>
  Object.entries(rows).map(([sku, r]) => ({ sku, bond: r.bond, physical: r.bond + r.nonBond, usable: r.usable }));

const PREVIOUS: ReportSnapshot = {
  contentHash: "SYNTHETIC-SNAPSHOT-PREVIOUS", takenAt: "2026-11-12T08:00:00.000Z",
  stock: stock({ "SYN-JKT-M": { bond: 200, nonBond: 40, usable: 40 }, "SYN-JKT-L": { bond: 150, nonBond: 30, usable: 30 }, "SYN-RAIN-M": { bond: 140, nonBond: 10, usable: 10 }, "SYN-RAIN-L": { bond: 130, nonBond: 20, usable: 20 }, "SYN-CAP-XL": { bond: 60, nonBond: 15, usable: 15 } }),
};
const CURRENT: ReportSnapshot = {
  contentHash: "SYNTHETIC-SNAPSHOT-CURRENT", takenAt: "2026-11-13T08:00:00.000Z",
  stock: stock({ "SYN-JKT-M": { bond: 200, nonBond: 40, usable: 40 }, "SYN-JKT-L": { bond: 150, nonBond: 30, usable: 30 }, "SYN-RAIN-M": { bond: 100, nonBond: 50, usable: 50 }, "SYN-RAIN-L": { bond: 90, nonBond: 60, usable: 60 }, "SYN-CAP-XL": { bond: 60, nonBond: 15, usable: 15 } }),
};

const entry = (id: string, n: number, provenance: "CUSTOMS_DOCUMENT" | "BROKER_CONFIRMATION" | "OWNER_STATEMENT", lines: { sku: string; quantity: number }[], documentRef?: string): RegisterEvent => ({
  type: "CLEARANCE_ADDED",
  entry: { id, shipmentRef: `SYN-SHIP-${n}`, clearanceRef: `SYN-BOE-${n}`, clearanceDate: "2026-11-10", lines, attributedTo: WHO, provenance, ...(documentRef ? { documentRef } : {}), recordedOn: "2026-11-10" },
});
const EVENTS: RegisterEvent[] = [
  entry("CL-1", 1, "CUSTOMS_DOCUMENT", [{ sku: "SYN-JKT-M", quantity: 120 }, { sku: "SYN-RAIN-M", quantity: 100 }], "SYN-DOC-1"), // partial clearance of the jackets
  { type: "CLEARANCE_VERIFIED", entryId: "CL-1", verifiedBy: WHO, verifiedOn: "2026-11-11", verifiedAt: "2026-11-11T08:00:00.000Z", documentRef: "SYN-DOC-1" },
  entry("CL-2", 2, "OWNER_STATEMENT", [{ sku: "SYN-JKT-L", quantity: 150 }]), // a statement only: recorded, can never be verified, stays NOT CLEARED
  entry("CL-3", 3, "BROKER_CONFIRMATION", [{ sku: "SYN-RAIN-L", quantity: 90 }], "SYN-DOC-3"), // recorded against the wrong shipment, then withdrawn
  { type: "CLEARANCE_WITHDRAWN", entryId: "CL-3", by: WHO, on: "2026-11-11", reason: "synthetic: entered against the wrong shipment reference" },
  entry("CL-4", 4, "BROKER_CONFIRMATION", [{ sku: "SYN-CAP-XL", quantity: 60 }], "SYN-DOC-4"),
  { type: "CLEARANCE_VERIFIED", entryId: "CL-4", verifiedBy: WHO, verifiedOn: "2026-11-11", verifiedAt: "2026-11-11T09:00:00.000Z", documentRef: "SYN-DOC-4" },
  { type: "TRANSFER_PROPOSED", proposal: { id: "P-1", sku: "SYN-JKT-M", quantity: 80, destination: "JHB", proposedBy: WHO, proposedOn: "2026-11-12", reason: "synthetic: replenish the Johannesburg store" } },
  { type: "TRANSFER_PROPOSED", proposal: { id: "P-2", sku: "SYN-RAIN-M", quantity: 40, destination: "DURBAN", proposedBy: WHO, proposedOn: "2026-11-12", reason: "synthetic: Durban order" } },
  // Completed by hand in the (invented) warehouse system and observed as a Bond decrease between the two snapshots; covered by verified clearance.
  { type: "RELEASE_RECORDED", id: "R-1", sku: "SYN-RAIN-M", quantity: 40, on: "2026-11-13", recordedBy: WHO, fromSnapshotHash: PREVIOUS.contentHash, toSnapshotHash: CURRENT.contentHash, fromTakenAt: PREVIOUS.takenAt, toTakenAt: CURRENT.takenAt, proposalId: "P-2" },
  // A Bond decrease with NO verified clearance behind it: recorded as a movement, flagged as an exception, never treated as cleared.
  { type: "RELEASE_RECORDED", id: "R-2", sku: "SYN-RAIN-L", quantity: 40, on: "2026-11-13", recordedBy: WHO, fromSnapshotHash: PREVIOUS.contentHash, toSnapshotHash: CURRENT.contentHash, fromTakenAt: PREVIOUS.takenAt, toTakenAt: CURRENT.takenAt },
];

export function buildSyntheticBondReport(): BondReport {
  return buildBondReport({
    snapshot: CURRENT, previous: PREVIOUS, state: foldRegister(EVENTS, { asOf: "2026-11-14" }), registerTipHash: "SYNTHETIC", registerEvents: EVENTS.length,
    generatedAt: "2026-11-14T08:00:00.000Z", dataClass: "SYNTHETIC_DEMONSTRATION",
    extraStatements: ["SYNTHETIC DEMONSTRATION: every value below is invented. A synthetic clearance is not a real customs event and is not RWTSA data."],
  });
}
