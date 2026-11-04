import { describe, expect, it } from "vitest";
import { reconcileSnapshot } from "@/rwtsa-live/reconcile";
import type { SkuStock } from "@/rwtsa-live/snapshot";

const st = (sku: string, o: Partial<SkuStock>): SkuStock => ({ sku, byRole: {}, physical: 0, bond: 0, unrestricted: 0, allocatedUnrestricted: 0, usable: 0, unmapped: 0, reportedAvailable: 0, onOrder: 0, inTransit: 0, ...o });
const wb = (sku: string, o: Partial<{ jhb: number; durban: number; capeTown: number; factoryStore: number; bond: number; committed: number }>) => ({ sku, jhb: 0, durban: 0, capeTown: 0, factoryStore: 0, bond: 0, committed: 0, ...o });

describe("workbook versus Cin7 reconciliation (report only)", () => {
  it("compares physical, bond, allocated and usable per SKU and never forces them to match", () => {
    const r = reconcileSnapshot({ snapshotStock: [st("A", { physical: 30, bond: 5, unrestricted: 25, allocatedUnrestricted: 4, usable: 21 })], workbook: [wb("A", { jhb: 10, durban: 5, capeTown: 5, factoryStore: 5, bond: 5, committed: 4 })], knownTransactions: [] });
    const a = r.rows[0]; expect(a.workbook).toMatchObject({ physical: 30, bond: 5, usable: 21 }); expect(a.cin7).toMatchObject({ physical: 30, bond: 5, usable: 21 }); expect(a.status).toBe("MATCH"); expect(r.summary.match).toBe(1);
  });
  it("explains a difference only with an owner-supplied known transaction, and reports the residual", () => {
    const base = { snapshotStock: [st("A", { physical: 40, unrestricted: 40, usable: 40 })], workbook: [wb("A", { jhb: 30 })] };
    const none = reconcileSnapshot({ ...base, knownTransactions: [] }); expect(none.rows[0].status).toBe("UNEXPLAINED"); expect(none.rows[0].residualPhysical).toBe(10);
    const full = reconcileSnapshot({ ...base, knownTransactions: [{ ref: "PO-00002", sku: "A", physicalDelta: 10 }] }); expect(full.rows[0].status).toBe("EXPLAINED"); expect(full.rows[0].residualPhysical).toBe(0);
    const part = reconcileSnapshot({ ...base, knownTransactions: [{ ref: "MO-00001", sku: "A", physicalDelta: 6 }] }); expect(part.rows[0].status).toBe("UNEXPLAINED"); expect(part.rows[0].residualPhysical).toBe(4);
  });
  it("lists SKUs present on only one side", () => {
    const r = reconcileSnapshot({ snapshotStock: [st("N", { physical: 1 })], workbook: [wb("W", { jhb: 1 })], knownTransactions: [] });
    expect(r.rows.map((x) => `${x.sku}:${x.status}`).sort()).toEqual(["N:ONLY_IN_CIN7", "W:ONLY_IN_WORKBOOK"]);
  });
  it("does not mutate its inputs", () => {
    const workbook = [wb("A", { jhb: 3 })]; const copy = JSON.stringify(workbook); reconcileSnapshot({ snapshotStock: [st("A", { physical: 3 })], workbook, knownTransactions: [] }); expect(JSON.stringify(workbook)).toBe(copy);
  });
});

import { assertReconcilable, parseKnownTransactions } from "@/rwtsa-live/reconcile";
describe("reconcile input hardening (independent review P1/P2)", () => {
  const complete = { completeness: { status: "COMPLETE" }, source: { identity: { status: "VERIFIED" } } } as never, partial = { completeness: { status: "INCOMPLETE" }, source: { identity: { status: "VERIFIED" } } } as never;
  it("refuses an INCOMPLETE snapshot unless explicitly allowed", () => {
    expect(() => assertReconcilable(complete, false)).not.toThrow();
    expect(() => assertReconcilable(partial, false)).toThrow(/incomplete/i);
    expect(() => assertReconcilable(partial, true)).not.toThrow();
  });
  it("always requires a VERIFIED account identity, even with --allow-incomplete", () => {
    for (const status of ["NOT_APPROVED", "ACCOUNT_MISMATCH", "FINGERPRINT_MISMATCH", undefined]) {
      const s = { completeness: { status: "COMPLETE" }, source: { identity: status ? { status } : undefined } } as never;
      expect(() => assertReconcilable(s, true)).toThrow(/identity/i);
    }
  });
  it("validates the known-transactions file: numbers only, unique ref+sku", () => {
    expect(parseKnownTransactions([{ ref: "PO-00002", sku: "A", physicalDelta: 5 }])).toHaveLength(1);
    for (const bad of [{}, [{ ref: "x", sku: "A", physicalDelta: "5" }], [{ ref: "x", sku: "A", physicalDelta: NaN }], [{ ref: "x", sku: "A", physicalDelta: 1 }, { ref: "x", sku: "A", physicalDelta: 1 }], [{ sku: "A", physicalDelta: 1 }]]) expect(() => parseKnownTransactions(bad)).toThrow();
  });
  it("refuses duplicate workbook SKUs instead of silently overwriting one", () => {
    expect(() => reconcileSnapshot({ snapshotStock: [], workbook: [wb("A", { jhb: 1 }), wb("A", { jhb: 2 })], knownTransactions: [] })).toThrow(/duplicate/i);
  });
  it("compares decimals with a tolerance, not exact float equality", () => {
    const r = reconcileSnapshot({ snapshotStock: [st("A", { physical: 0.1 + 0.2, usable: 0.1 + 0.2 })], workbook: [wb("A", { jhb: 0.3 })], knownTransactions: [] });
    expect(r.rows[0].status).toBe("MATCH");
  });
});
