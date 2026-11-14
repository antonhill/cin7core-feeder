import { describe, expect, it } from "vitest";
import { reconcileSnapshot } from "@/rwtsa-live/reconcile";
import type { SkuStock } from "@/rwtsa-live/snapshot";

// A Cin7 SKU: nonBond = on-hand outside Bond; usable = nonBond - allocated.
const cin = (sku: string, o: { nonBond?: number; bond?: number; allocated?: number }): SkuStock => {
  const nonBond = o.nonBond ?? 0, bond = o.bond ?? 0, allocated = o.allocated ?? 0;
  return { sku, byRole: {}, physical: nonBond + bond, bond, unrestricted: nonBond, allocatedUnrestricted: allocated, usable: nonBond - allocated, unmapped: 0, reportedAvailable: nonBond - allocated, onOrder: 0, inTransit: 0 };
};
const wb = (sku: string, o: Partial<{ jhb: number; durban: number; capeTown: number; factoryStore: number; bond: number; committed: number }>) => ({ sku, jhb: 0, durban: 0, capeTown: 0, factoryStore: 0, bond: 0, committed: 0, ...o });
const run = (c: SkuStock[], w: ReturnType<typeof wb>[], known: { ref: string; sku: string; physicalDelta: number; bondDelta?: number }[] = [], accept = false) =>
  reconcileSnapshot({ snapshotStock: c, workbook: w, knownTransactions: known, acceptSourceOnlyAllocations: accept });

describe("separate reconciliation dimensions", () => {
  it("source commitments absent from Cin7 are KNOWN SOURCE-ONLY ALLOCATIONS (not a physical discrepancy) once the owner accepts them", () => {
    const r = run([cin("A", { nonBond: 50 })], [wb("A", { jhb: 50, committed: 8 })], [], true).rows[0];
    expect(r.physicalStatus).toBe("MATCH");
    expect(r.bondStatus).toBe("MATCH");
    expect(r.allocationStatus).toBe("SOURCE_ONLY_ALLOCATION");
    expect(r.usableStatus).toBe("EXPLAINED");
    expect(r.status).toBe("KNOWN_SOURCE_ONLY_ALLOCATION");
    expect(r.sourceOnlyAllocation).toBe(8);
    expect(r.residualUsable).toBe(0);
  });
  it("without the owner's acceptance the same difference stays UNEXPLAINED (never silently classified)", () => {
    const r = run([cin("A", { nonBond: 50 })], [wb("A", { jhb: 50, committed: 8 })]).rows[0];
    expect(r.allocationStatus).toBe("UNEXPLAINED");
    expect(r.status).toBe("UNEXPLAINED");
    expect(r.sourceOnlyAllocation).toBe(0);
  });
  it("never substitutes source commitments into Cin7 quantities; shows operational and planning availability side by side", () => {
    const r = run([cin("A", { nonBond: 50 })], [wb("A", { jhb: 50, committed: 8 })], [], true).rows[0];
    expect(r.cin7.allocated).toBe(0);
    expect(r.cin7.usable).toBe(50);
    expect(r.cin7OperationalAvailable).toBe(50);
    expect(r.rwtsaPlanningAvailable).toBe(42);
  });
  it("an allocation that exists in Cin7 but differs from the workbook is NOT source-only, even when accepted", () => {
    for (const allocated of [3, 20]) {
      const r = run([cin("A", { nonBond: 50, allocated })], [wb("A", { jhb: 50, committed: 8 })], [], true).rows[0];
      expect(r.allocationStatus).toBe("UNEXPLAINED");
      expect(r.status).toBe("UNEXPLAINED");
    }
  });
  it("Cin7 allocation with no workbook commitment is UNEXPLAINED", () => {
    const r = run([cin("A", { nonBond: 50, allocated: 5 })], [wb("A", { jhb: 50 })], [], true).rows[0];
    expect(r.allocationStatus).toBe("UNEXPLAINED");
  });
  it("a genuine physical difference is never masked by a source-only allocation", () => {
    const r = run([cin("A", { nonBond: 55 })], [wb("A", { jhb: 50, committed: 8 })], [], true).rows[0];
    expect(r.physicalStatus).toBe("UNEXPLAINED");
    expect(r.residualPhysical).toBe(5);
    expect(r.usableStatus).toBe("UNEXPLAINED");
    expect(r.residualUsable).toBe(5);
    expect(r.status).toBe("UNEXPLAINED");
  });
  it("a genuine Bond difference is reported separately from physical", () => {
    const r = run([cin("A", { nonBond: 50, bond: 12 })], [wb("A", { jhb: 50, bond: 10 })]).rows[0];
    expect(r.bondStatus).toBe("UNEXPLAINED");
    expect(r.residualBond).toBe(2);
    expect(r.physicalStatus).toBe("UNEXPLAINED");
    expect(r.usableStatus).toBe("MATCH");
  });
  it("known Bond receipt explains physical and Bond but not usable; known non-Bond output explains usable", () => {
    const po = run([cin("A", { nonBond: 50, bond: 40 })], [wb("A", { jhb: 50, bond: 10 })], [{ ref: "PO-00002", sku: "A", physicalDelta: 30, bondDelta: 30 }]).rows[0];
    expect(po.physicalStatus).toBe("EXPLAINED_KNOWN");
    expect(po.bondStatus).toBe("EXPLAINED_KNOWN");
    expect(po.usableStatus).toBe("MATCH");
    expect(po.status).toBe("EXPLAINED");
    const mo = run([cin("B", { nonBond: 60 })], [wb("B", { factoryStore: 50 })], [{ ref: "MO-00001", sku: "B", physicalDelta: 10 }]).rows[0];
    expect(mo.physicalStatus).toBe("EXPLAINED_KNOWN");
    expect(mo.bondStatus).toBe("MATCH");
    expect(mo.usableStatus).toBe("EXPLAINED");
    expect(mo.status).toBe("EXPLAINED");
  });
  it("known movement plus source-only allocation: usable is explained by both and the overall status stays visible as source-only", () => {
    const r = run([cin("A", { nonBond: 60 })], [wb("A", { jhb: 50, committed: 8 })], [{ ref: "MO-00001", sku: "A", physicalDelta: 10 }], true).rows[0];
    expect(r.deltaUsable).toBe(18);
    expect(r.residualUsable).toBe(0);
    expect(r.status).toBe("KNOWN_SOURCE_ONLY_ALLOCATION");
  });
  it("a known transaction that is NOT visible in Cin7 is UNEXPLAINED (the claim is not taken on trust)", () => {
    const r = run([cin("A", { nonBond: 50 })], [wb("A", { jhb: 50 })], [{ ref: "MO-00001", sku: "A", physicalDelta: 10 }]).rows[0];
    expect(r.physicalStatus).toBe("UNEXPLAINED");
    expect(r.residualPhysical).toBe(-10);
    expect(r.status).toBe("UNEXPLAINED");
  });
  it("a partial explanation leaves the remainder as the residual", () => {
    const r = run([cin("A", { nonBond: 60 })], [wb("A", { jhb: 50 })], [{ ref: "MO-00001", sku: "A", physicalDelta: 6 }]).rows[0];
    expect(r.physicalStatus).toBe("UNEXPLAINED");
    expect(r.residualPhysical).toBe(4);
  });
  it("summarises each dimension, the known/source-only totals and both availabilities, and keeps genuine unexplained units", () => {
    const s = run(
      [cin("A", { nonBond: 50 }), cin("B", { nonBond: 60, bond: 40 }), cin("C", { nonBond: 30 }), cin("D", { nonBond: 9 })],
      [wb("A", { jhb: 50, committed: 8 }), wb("B", { jhb: 50, bond: 10 }), wb("C", { jhb: 30 }), wb("D", { jhb: 4 })],
      [{ ref: "PO-00002", sku: "B", physicalDelta: 40, bondDelta: 30 }],
      true,
    ).summary;
    expect(s.skus).toBe(4);
    expect(s).toMatchObject({ match: 1, explained: 1, knownSourceOnlyAllocation: 1, unexplained: 1 });
    expect(s.byDimension.physical).toEqual({ match: 2, explainedKnown: 1, unexplained: 1 });
    expect(s.byDimension.bond).toEqual({ match: 3, explainedKnown: 1, unexplained: 0 });
    expect(s.byDimension.allocation).toEqual({ match: 3, sourceOnly: 1, unexplained: 0 });
    expect(s.byDimension.usable).toEqual({ match: 1, explained: 2, unexplained: 1 });
    expect(s.totals).toMatchObject({ knownPhysical: 40, knownBond: 30, knownNonBond: 10, sourceOnlyAllocationUnits: 8, unexplainedPhysicalUnits: 5, unexplainedBondUnits: 0, unexplainedUsableUnits: 5 });
    expect(s.totals.cin7OperationalAvailable).toBe(50 + 60 + 30 + 9);
    expect(s.totals.rwtsaPlanningAvailable).toBe(50 - 8 + 60 + 30 + 9);
  });
  it("overall status keeps the four existing meanings for rows without source-only allocations", () => {
    const r = run([cin("M", { nonBond: 5 }), cin("N", { nonBond: 1 })], [wb("M", { jhb: 5 }), wb("W", { jhb: 1 })]).rows;
    expect(r.map((x) => `${x.sku}:${x.status}`).sort()).toEqual(["M:MATCH", "N:ONLY_IN_CIN7", "W:ONLY_IN_WORKBOOK"]);
  });
  it("does not mutate inputs and tolerates decimal arithmetic", () => {
    const workbook = [wb("A", { jhb: 0.3, committed: 0.1 })], snapshotStock = [cin("A", { nonBond: 0.1 + 0.2 })];
    const before = JSON.stringify({ workbook, snapshotStock });
    const r = run(snapshotStock, workbook, [], true).rows[0];
    expect(JSON.stringify({ workbook, snapshotStock })).toBe(before);
    expect(r.physicalStatus).toBe("MATCH");
    expect(r.allocationStatus).toBe("SOURCE_ONLY_ALLOCATION");
    expect(r.usableStatus).toBe("EXPLAINED");
  });
});
