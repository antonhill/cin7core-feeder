import { describe, expect, it } from "vitest";
import { foldRegister, type RegisterEvent } from "@/rwtsa-live/bond/engine";
import { buildBondReport, BOND_REPORT_SCHEMA_VERSION } from "@/rwtsa-live/bond/report";

const snap = (hash: string, takenAt: string, rows: Record<string, { bond: number; nonBond?: number; usable?: number }>) => ({
  contentHash: hash, takenAt,
  stock: Object.entries(rows).map(([sku, r]) => ({ sku, bond: r.bond, physical: r.bond + (r.nonBond ?? 0), usable: r.usable ?? r.nonBond ?? 0 })),
});
const events: RegisterEvent[] = [
  { type: "CLEARANCE_ADDED", entry: { id: "CL-1", shipmentRef: "S-1", clearanceRef: "C-1", clearanceDate: "2026-11-10", lines: [{ sku: "A", quantity: 60 }], attributedTo: "owner", provenance: "CUSTOMS_DOCUMENT", documentRef: "d1", recordedOn: "2026-11-10" } },
  { type: "CLEARANCE_VERIFIED", entryId: "CL-1", verifiedBy: "owner", verifiedOn: "2026-11-11", verifiedAt: "2026-11-11T08:00:00.000Z", documentRef: "d1" },
  { type: "CLEARANCE_ADDED", entry: { id: "CL-2", shipmentRef: "S-2", clearanceRef: "C-2", clearanceDate: "2026-11-10", lines: [{ sku: "B", quantity: 30 }], attributedTo: "owner", provenance: "OWNER_STATEMENT", recordedOn: "2026-11-10" } },
  { type: "CLEARANCE_ADDED", entry: { id: "CL-3", shipmentRef: "S-3", clearanceRef: "C-3", clearanceDate: "2026-11-10", lines: [{ sku: "A", quantity: 5 }], attributedTo: "owner", provenance: "BROKER_CONFIRMATION", recordedOn: "2026-11-10" } },
  { type: "CLEARANCE_WITHDRAWN", entryId: "CL-3", by: "owner", on: "2026-11-12", reason: "wrong shipment" },
  { type: "TRANSFER_PROPOSED", proposal: { id: "P-1", sku: "A", quantity: 40, destination: "JHB", proposedBy: "owner", proposedOn: "2026-11-12", reason: "demo" } },
];
const build = (extra: Partial<Parameters<typeof buildBondReport>[0]> = {}) =>
  buildBondReport({ snapshot: snap("h2", "2026-11-13T08:00:00.000Z", { A: { bond: 100 }, B: { bond: 50 } }), state: foldRegister(events, { asOf: "2026-11-14" }), registerTipHash: "t", registerEvents: events.length, generatedAt: "2026-11-14T08:00:00.000Z", ...extra });

describe("bond report contract (consumed by the offline dashboard)", () => {
  it("is schema version 2 and labels real snapshot data by default", () => {
    const r = build();
    expect(r.schemaVersion).toBe(BOND_REPORT_SCHEMA_VERSION);
    expect(BOND_REPORT_SCHEMA_VERSION).toBe(2);
    expect(r.dataClass).toBe("REAL_CIN7_SNAPSHOT");
  });
  it("carries evidence provenance for every clearance entry, with its verification status", () => {
    const r = build();
    expect(r.evidence.map((e) => `${e.id}:${e.status}:${e.provenance}`)).toEqual(["CL-1:VERIFIED:CUSTOMS_DOCUMENT", "CL-2:UNVERIFIED_NOT_CLEARED:OWNER_STATEMENT", "CL-3:WITHDRAWN:BROKER_CONFIRMATION"]);
    expect(r.evidence[0]).toMatchObject({ shipmentRef: "S-1", clearanceRef: "C-1", clearanceDate: "2026-11-10", attributedTo: "owner", verifiedBy: "owner", verifiedOn: "2026-11-11", verificationDocumentRef: "d1", lines: [{ sku: "A", quantity: 60 }] });
    expect(r.evidence[2]).toMatchObject({ withdrawnReason: "wrong shipment" });
  });
  it("lists proposals and releases with their state", () => {
    const r = build();
    expect(r.proposals).toEqual([expect.objectContaining({ id: "P-1", sku: "A", quantity: 40, destination: "JHB", status: "OPEN", completedQuantity: 0 })]);
    expect(r.releases).toEqual([]);
  });
  it("an explicit data class is preserved, and the report states it", () => {
    expect(build({ dataClass: "SYNTHETIC_DEMONSTRATION" }).dataClass).toBe("SYNTHETIC_DEMONSTRATION");
  });
  it("keeps the facts the dashboard shows: Bond stock, verified-cleared, eligible, proposed and exceptions per SKU", () => {
    const r = build();
    expect(r.rows.find((x) => x.sku === "A")).toMatchObject({ bondPhysical: 100, verifiedCleared: 60, eligible: 60, activeProposed: 40, clearanceStatus: "PARTIALLY_CLEARED" });
    expect(r.rows.find((x) => x.sku === "B")).toMatchObject({ bondPhysical: 50, verifiedCleared: 0, unverifiedClaimed: 30, eligible: 0, clearanceStatus: "NOT_CLEARED" });
    expect(r.summary).toMatchObject({ bondUnits: 150, verifiedClearedUnits: 60, eligibleUnits: 60, proposedUnits: 40 });
  });
});
