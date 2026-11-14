import { describe, expect, it } from "vitest";
import { assessBond, foldRegister, observeBondMovement, validateProposal, type ClearanceEntry, type RegisterEvent } from "@/rwtsa-live/bond/engine";

const entry = (o: Partial<ClearanceEntry> = {}): ClearanceEntry => ({ id: "CL-1", shipmentRef: "SHIP-A", clearanceRef: "BOE-1", clearanceDate: "2026-11-10", lines: [{ sku: "A", quantity: 100 }], attributedTo: "owner", provenance: "CUSTOMS_DOCUMENT", documentRef: "doc-1", recordedOn: "2026-11-11", ...o });
const add = (o: Partial<ClearanceEntry> = {}): RegisterEvent => ({ type: "CLEARANCE_ADDED", entry: entry(o) });
const verify = (entryId = "CL-1"): RegisterEvent => ({ type: "CLEARANCE_VERIFIED", entryId, verifiedBy: "owner", verifiedOn: "2026-11-12", documentRef: "doc-1" });
const AS_OF = "2026-11-14";
const rel = (o: Partial<Extract<RegisterEvent, { type: "RELEASE_RECORDED" }>> = {}): RegisterEvent => ({ type: "RELEASE_RECORDED", id: "R1", sku: "A", quantity: 30, on: "2026-11-13", recordedBy: "owner", fromSnapshotHash: "h1", toSnapshotHash: "h2", fromTakenAt: "2026-11-12T08:00:00.000Z", toTakenAt: "2026-11-13T08:00:00.000Z", ...o } as RegisterEvent);
const fold = (ev: RegisterEvent[]) => foldRegister(ev, { asOf: AS_OF });
const bond = (m: Record<string, number>) => new Map(Object.entries(m));
const one = (ev: RegisterEvent[], b: number, sku = "A") => assessBond(fold(ev), { bondBySku: bond({ [sku]: b }) }).find((r) => r.sku === sku)!;

describe("clearance entries (evidence rules)", () => {
  it("an entry with no verification is NOT CLEARED: nothing is eligible", () => {
    const r = one([add()], 100);
    expect(r.clearanceStatus).toBe("NOT_CLEARED");
    expect(r.verifiedCleared).toBe(0);
    expect(r.unverifiedClaimed).toBe(100);
    expect(r.eligible).toBe(0);
  });
  it("a verified entry makes its quantity eligible, capped by physical Bond stock", () => {
    expect(one([add(), verify()], 100)).toMatchObject({ clearanceStatus: "CLEARED", verifiedCleared: 100, eligible: 100 });
    expect(one([add(), verify()], 60)).toMatchObject({ eligible: 60, clearedExceedsBond: true });
    expect(one([add(), verify()], 250)).toMatchObject({ clearanceStatus: "PARTIALLY_CLEARED", eligible: 100 });
  });
  it("partial clearance: only the cleared SKU quantities count, per SKU", () => {
    const ev = [add({ lines: [{ sku: "A", quantity: 40 }, { sku: "B", quantity: 10 }] }), verify()];
    const rows = assessBond(fold(ev), { bondBySku: bond({ A: 100, B: 100, C: 100 }) });
    expect(rows.map((r) => `${r.sku}:${r.eligible}`)).toEqual(["A:40", "B:10", "C:0"]);
  });
  it("two verified clearances for the same SKU add up", () => {
    const ev = [add(), verify(), add({ id: "CL-2", clearanceRef: "BOE-2", lines: [{ sku: "A", quantity: 30 }] }), verify("CL-2")];
    expect(one(ev, 500).verifiedCleared).toBe(130);
  });
  it("a withdrawn clearance no longer counts", () => {
    const r = one([add(), verify(), { type: "CLEARANCE_WITHDRAWN", entryId: "CL-1", by: "owner", on: "2026-11-13", reason: "wrong reference" }], 100);
    expect(r).toMatchObject({ verifiedCleared: 0, eligible: 0, clearanceStatus: "NOT_CLEARED" });
  });
  it("required evidence fields are enforced", () => {
    const cases: [Partial<ClearanceEntry>, RegExp][] = [[{ shipmentRef: "" }, /shipment/i], [{ clearanceRef: " " }, /clearance reference/i], [{ clearanceDate: "10/11/2026" }, /clearance date/i], [{ clearanceDate: "2026-02-30" }, /clearance date/i], [{ attributedTo: "" }, /attribution/i], [{ lines: [] }, /line/i], [{ lines: [{ sku: "A", quantity: 0 }] }, /positive/i], [{ lines: [{ sku: "A", quantity: -1 }] }, /positive/i], [{ lines: [{ sku: "A", quantity: NaN }] }, /positive/i], [{ lines: [{ sku: "A", quantity: 1 }, { sku: "A", quantity: 2 }] }, /duplicate SKU/i], [{ clearanceDate: "2026-11-20" }, /future/i]];
    for (const [bad, msg] of cases) expect(() => fold([add(bad)])).toThrow(msg);
  });
  it("transfers, posted duty and freight invoices can never be the evidence provenance", () => {
    for (const p of ["STOCK_TRANSFER", "DUTY_POSTED", "FREIGHT_INVOICE", "LANDED_COST", "WAREHOUSE_TRANSFER", "", "customs_document"]) {
      expect(() => fold([add({ provenance: p as never })])).toThrow(/provenance/i);
    }
  });
  it("an owner statement alone can be recorded but can never be verified (stays NOT CLEARED)", () => {
    expect(() => fold([add({ provenance: "OWNER_STATEMENT" }), verify()])).toThrow(/owner statement/i);
    expect(one([add({ provenance: "OWNER_STATEMENT" })], 100).eligible).toBe(0);
  });
  it("verification needs a known, live, not-yet-verified entry, a verifier and a document reference", () => {
    expect(() => fold([verify()])).toThrow(/unknown clearance/i);
    expect(() => fold([add(), verify(), verify()])).toThrow(/already verified/i);
    expect(() => fold([add(), { ...verify(), verifiedBy: "" } as RegisterEvent])).toThrow(/verifier/i);
    expect(() => fold([add(), { ...verify(), documentRef: "" } as RegisterEvent])).toThrow(/document reference/i);
    expect(() => fold([add(), { type: "CLEARANCE_WITHDRAWN", entryId: "CL-1", by: "o", on: "2026-11-13", reason: "x" }, verify()])).toThrow(/withdrawn/i);
  });
  it("the same clearance reference cannot be counted twice for a SKU, nor an id reused", () => {
    expect(() => fold([add(), add({ id: "CL-2" })])).toThrow(/duplicate clearance reference/i);
    expect(() => fold([add(), add({ id: "CL-2", clearanceRef: " boe-1 " })])).toThrow(/duplicate clearance reference/i);
    expect(() => fold([add(), add({ clearanceRef: "BOE-9" })])).toThrow(/duplicate clearance id/i);
  });
});

describe("release never exceeds verified clearance or physical Bond", () => {
  const cleared = [add(), verify()];
  it("recorded releases reduce what remains eligible", () => {
    const r = one([...cleared, rel({ quantity: 30 })], 70);
    expect(r).toMatchObject({ released: 30, remainingCleared: 70, eligible: 70 });
    expect(one([...cleared, rel({ quantity: 30 })], 20).eligible).toBe(20);
  });
  it("a release larger than the verified clearance is flagged OVER_RELEASED and is never promoted to cleared", () => {
    const r = one([...cleared, rel({ quantity: 130 })], 500);
    expect(r.exceptions).toContain("OVER_RELEASED");
    expect(r.verifiedCleared).toBe(100);
    expect(r.eligible).toBe(0);
  });
  it("a release recorded against a SKU with no clearance is OVER_RELEASED and creates no clearance", () => {
    const r = one([rel({ quantity: 10 })], 90);
    expect(r).toMatchObject({ verifiedCleared: 0, eligible: 0, clearanceStatus: "NOT_CLEARED" });
    expect(r.exceptions).toContain("OVER_RELEASED");
  });
  it("eligibility is never negative", () => {
    const r = one([...cleared, rel({ quantity: 500 })], 0);
    expect(r.eligible).toBe(0);
    expect(r.remainingCleared).toBe(0);
  });
});

describe("proposed transfers (never a Cin7 transaction)", () => {
  const cleared = [add(), verify()];
  const propose = (q: number, id = "P1"): RegisterEvent => ({ type: "TRANSFER_PROPOSED", proposal: { id, sku: "A", quantity: q, destination: "JHB", proposedBy: "owner", proposedOn: "2026-11-13", reason: "demo" } });
  it("a proposal within eligibility is accepted and shown, without changing any clearance figure", () => {
    const r = one([...cleared, propose(40)], 100);
    expect(r).toMatchObject({ activeProposed: 40, verifiedCleared: 100, eligible: 100 });
    expect(r.exceptions).not.toContain("PROPOSAL_EXCEEDS_ELIGIBLE");
  });
  it("validateProposal refuses uncleared SKUs, over-eligible quantity (including other open proposals), Bond as destination, and bad input", () => {
    const st = fold([...cleared, propose(40)]);
    const ctx = { bondBySku: bond({ A: 100, B: 100 }) };
    expect(validateProposal(st, ctx, { sku: "A", quantity: 60, destination: "DURBAN" }).ok).toBe(true);
    expect(validateProposal(st, ctx, { sku: "A", quantity: 61, destination: "DURBAN" })).toMatchObject({ ok: false });
    expect(validateProposal(st, ctx, { sku: "B", quantity: 1, destination: "DURBAN" })).toMatchObject({ ok: false });
    expect(validateProposal(st, ctx, { sku: "A", quantity: 1, destination: "BOND" as never })).toMatchObject({ ok: false });
    expect(validateProposal(st, ctx, { sku: "A", quantity: 0, destination: "JHB" })).toMatchObject({ ok: false });
    expect(validateProposal(st, ctx, { sku: "Z", quantity: 1, destination: "JHB" })).toMatchObject({ ok: false });
  });
  it("an existing proposal that later exceeds eligibility (e.g. clearance withdrawn) is flagged, not hidden", () => {
    const r = one([...cleared, propose(40), { type: "CLEARANCE_WITHDRAWN", entryId: "CL-1", by: "o", on: "2026-11-13", reason: "x" }], 100);
    expect(r.exceptions).toContain("PROPOSAL_EXCEEDS_ELIGIBLE");
  });
  it("a withdrawn proposal stops counting", () => {
    expect(one([...cleared, propose(40), { type: "PROPOSAL_WITHDRAWN", proposalId: "P1", by: "o", on: "2026-11-13", reason: "x" }], 100).activeProposed).toBe(0);
  });
  it("shows operational usable and a labelled projection if the proposal were completed; the projection is not a fact", () => {
    const st = fold([...cleared, propose(40)]);
    const r = assessBond(st, { bondBySku: bond({ A: 100 }), operationalUsableBySku: bond({ A: 25 }) })[0];
    expect(r.operationalUsable).toBe(25);
    expect(r.projectedUsableIfProposedCompleted).toBe(65);
  });
});

describe("observed transfers and exceptions", () => {
  const cleared = [add(), verify()];
  const snap = (b: Record<string, number>, nb: Record<string, number> = {}) => ({ bondBySku: bond(b), nonBondBySku: bond(nb) });
  it("a Bond decrease within eligibility is a release, not an exception", () => {
    const o = observeBondMovement(fold(cleared), snap({ A: 100 }), snap({ A: 70 }, { A: 30 }))[0];
    expect(o).toMatchObject({ sku: "A", bondDecrease: 30, nonBondIncrease: 30, uncleared: 0 });
    expect(o.exceptions).toEqual([]);
  });
  it("a Bond decrease with no verified clearance is TRANSFER WITHOUT CLEARANCE EVIDENCE for the whole quantity", () => {
    const o = observeBondMovement(fold([add()]), snap({ A: 100 }), snap({ A: 60 }, { A: 40 }))[0];
    expect(o.uncleared).toBe(40);
    expect(o.exceptions).toContain("TRANSFER_WITHOUT_CLEARANCE_EVIDENCE");
  });
  it("only the excess over eligibility is uncleared", () => {
    const o = observeBondMovement(fold(cleared), snap({ A: 200 }), snap({ A: 50 }))[0];
    expect(o).toMatchObject({ bondDecrease: 150, uncleared: 50 });
  });
  it("a Bond increase is a receipt, never a release and never clearance", () => {
    const o = observeBondMovement(fold([add()]), snap({ A: 100 }), snap({ A: 160 }))[0];
    expect(o).toMatchObject({ bondDecrease: 0, bondIncrease: 60, uncleared: 0 });
  });
  it("observing or recording a transfer can never create verified clearance", () => {
    const st = fold([add(), rel({ quantity: 40 })]);
    expect(assessBond(st, { bondBySku: bond({ A: 60 }) })[0]).toMatchObject({ verifiedCleared: 0, eligible: 0, clearanceStatus: "NOT_CLEARED" });
  });
  it("transfers do not change eligibility inputs: only registered releases do (no inference from stock movement)", () => {
    const a = assessBond(fold(cleared), { bondBySku: bond({ A: 70 }) })[0];
    expect(a.released).toBe(0);
    expect(a.eligible).toBe(70);
  });
});

describe("determinism and immutability", () => {
  it("does not mutate its inputs and is order-independent for assessment rows (sorted by SKU)", () => {
    const ev = [add({ lines: [{ sku: "B", quantity: 5 }, { sku: "A", quantity: 5 }] }), verify()];
    const copy = JSON.stringify(ev);
    const rows = assessBond(fold(ev), { bondBySku: bond({ B: 9, A: 9 }) });
    expect(JSON.stringify(ev)).toBe(copy);
    expect(rows.map((r) => r.sku)).toEqual(["A", "B"]);
  });
  it("a clearance for a SKU absent from the Bond snapshot is reported, not dropped", () => {
    const rows = assessBond(fold([add({ lines: [{ sku: "Q", quantity: 5 }] }), verify()]), { bondBySku: bond({ A: 1 }) });
    expect(rows.find((r) => r.sku === "Q")).toMatchObject({ bondPhysical: 0, eligible: 0, inSnapshot: false });
  });
});

describe("independent review hardening (P1/P2)", () => {
  const cleared = [add(), verify()];
  it("non-finite or negative snapshot numbers are rejected, never silently treated as stock or hiding an exception", () => {
    const st = fold(cleared);
    for (const v of [NaN, Infinity, -Infinity, -1]) {
      expect(() => assessBond(st, { bondBySku: bond({ A: v }) })).toThrow(/finite|non-negative/i);
      expect(() => validateProposal(st, { bondBySku: bond({ A: v }) }, { sku: "A", quantity: 1, destination: "JHB" })).toThrow(/finite|non-negative/i);
      expect(() => observeBondMovement(st, { bondBySku: bond({ A: v }), nonBondBySku: bond({}) }, { bondBySku: bond({ A: 1 }), nonBondBySku: bond({}) })).toThrow(/finite|non-negative/i);
      expect(() => assessBond(st, { bondBySku: bond({ A: 1 }), operationalUsableBySku: bond({ A: v }) })).toThrow(/finite|non-negative/i);
    }
  });
  it("late verification cannot retroactively legitimise a release: RELEASED_BEFORE_VERIFICATION stays flagged", () => {
    const r = one([add(), rel({ quantity: 40 }), verify()], 60);
    expect(r.exceptions).toContain("RELEASED_BEFORE_VERIFICATION");
    expect(one([add(), verify(), rel({ quantity: 40 })], 60).exceptions).not.toContain("RELEASED_BEFORE_VERIFICATION");
  });
  it("a release partly covered by clearance flags only the uncovered part", () => {
    const r = one([add({ lines: [{ sku: "A", quantity: 25 }] }), verify(), rel({ quantity: 40 })], 60);
    expect(r.exceptions).toEqual(expect.arrayContaining(["OVER_RELEASED", "RELEASED_BEFORE_VERIFICATION"]));
    expect(r.releasedBeforeCover).toBe(15);
  });
  it("every event date must be a real date not later than asOf, and verification cannot predate the clearance", () => {
    expect(() => fold([add(), { ...verify(), verifiedOn: "2999-01-01" } as RegisterEvent])).toThrow(/future/i);
    expect(() => fold([add(), { ...verify(), verifiedOn: "2026-11-01" } as RegisterEvent])).toThrow(/before the clearance date/i);
    expect(() => fold([add({ recordedOn: "2999-01-01" })])).toThrow(/future/i);
    expect(() => fold([...cleared, rel({ on: "2999-01-01" })])).toThrow(/future/i);
    expect(() => fold([...cleared, { type: "CLEARANCE_WITHDRAWN", entryId: "CL-1", by: "o", on: "2999-01-01", reason: "x" }])).toThrow(/future/i);
    expect(() => fold([...cleared, { type: "TRANSFER_PROPOSED", proposal: { id: "P1", sku: "A", quantity: 1, destination: "JHB", proposedBy: "o", proposedOn: "2999-01-01", reason: "x" } }])).toThrow(/future/i);
  });
  it("references and SKUs are trimmed on ingest so whitespace cannot defeat duplicate detection or SKU matching", () => {
    expect(() => fold([add(), add({ id: "CL-2", clearanceRef: "BOE-1 " })])).toThrow(/duplicate clearance reference/i);
    expect(one([add({ lines: [{ sku: " A ", quantity: 10 }] }), verify()], 10).eligible).toBe(10);
  });
  it("a release that cites a proposal consumes it, so it no longer counts as open or raises a spurious exception", () => {
    const prop: RegisterEvent = { type: "TRANSFER_PROPOSED", proposal: { id: "P1", sku: "A", quantity: 40, destination: "JHB", proposedBy: "o", proposedOn: "2026-11-12", reason: "x" } };
    const r = one([...cleared, prop, rel({ quantity: 40, proposalId: "P1" })], 60);
    expect(r).toMatchObject({ activeProposed: 0, released: 40, eligible: 60 });
    expect(r.exceptions).toEqual([]);
    expect(() => fold([...cleared, rel({ proposalId: "NOPE" })])).toThrow(/unknown proposal/i);
  });
  it("a mistaken release can be voided by an appended event", () => {
    const r = one([...cleared, rel({ quantity: 40 }), { type: "RELEASE_VOIDED", releaseId: "R1", by: "o", on: "2026-11-13", reason: "typo" }], 100);
    expect(r).toMatchObject({ released: 0, eligible: 100 });
    expect(() => fold([...cleared, { type: "RELEASE_VOIDED", releaseId: "R9", by: "o", on: "2026-11-13", reason: "x" }])).toThrow(/unknown release/i);
  });
  it("releases for the same SKU may not cover overlapping snapshot intervals (no double-counting one movement)", () => {
    expect(() => fold([...cleared, rel(), rel({ id: "R2", fromSnapshotHash: "h9", toSnapshotHash: "h8", fromTakenAt: "2026-11-12T12:00:00.000Z", toTakenAt: "2026-11-13T12:00:00.000Z" })])).toThrow(/overlap/i);
    expect(() => fold([...cleared, rel(), rel({ id: "R2", fromSnapshotHash: "h2", toSnapshotHash: "h3", fromTakenAt: "2026-11-13T08:00:00.000Z", toTakenAt: "2026-11-14T08:00:00.000Z" })])).not.toThrow();
    expect(() => fold([...cleared, rel({ fromTakenAt: "2026-11-13T08:00:00.000Z", toTakenAt: "2026-11-12T08:00:00.000Z" })])).toThrow(/before/i);
  });
  it("observeBondMovement does not raise a false exception when the register already holds the release for that same snapshot pair", () => {
    const st = fold([...cleared, rel({ quantity: 100 })]);
    const snap = (b: Record<string, number>) => ({ bondBySku: bond(b), nonBondBySku: bond({}) });
    expect(observeBondMovement(st, snap({ A: 100 }), snap({ A: 0 }))[0].uncleared).toBe(100); // without the hashes, the register is not known to include it
    const o = observeBondMovement(st, snap({ A: 100 }), snap({ A: 0 }), { fromSnapshotHash: "h1", toSnapshotHash: "h2" })[0];
    expect(o.uncleared).toBe(0);
    expect(o.alreadyRecorded).toBe(100);
  });
  it("null or malformed events fail with a register error, not a raw TypeError", () => {
    expect(() => fold([null as never])).toThrow(/event 1/i);
    expect(() => fold([{ type: "CLEARANCE_ADDED", entry: null } as never])).toThrow(/event 1/i);
  });
});
