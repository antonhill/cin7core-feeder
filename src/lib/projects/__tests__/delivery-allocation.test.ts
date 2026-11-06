import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { allocKey, allocatedUninvoiced, buildQuantityPositions, sumInvoicedAgainstDeliveries, validateAllocationChange, type DeliveryRef } from "../delivery-allocation";
import { proposeInvoice, validateSelection } from "../invoice-proposal";
import { confirmMilestone, createDelivery, listMilestoneConfirmations, loadDeliveryEligibility, loadDeliveryRegister, setAllocation, setDeliveryStatus } from "../delivery-allocation-store";

const D1: DeliveryRef = { id: "d1", label: "Delivery 1", status: "PLANNED" };
const D2: DeliveryRef = { id: "d2", label: "Delivery 2", status: "LOADING" };
const scope = [{ sku: "A", description: "Alpha", quantity: 10 }, { sku: "B", description: "Bravo", quantity: 2 }];
const ctx = (over: Record<string, unknown> = {}) => ({ scope, deliveries: [D1, D2], allocations: [], invoicedAgainstDelivery: {}, ...over });
const chg = (o: Record<string, unknown> = {}) => ({ deliveryId: "d1", sku: "A", quantity: 4, reason: "first truck", ...o }) as never;

describe("quantity positions keep the seven quantities separate", () => {
  it("quoted / ordered / allocated / invoiced / shipped / remaining; unknown is null, never zero", () => {
    const p = buildQuantityPositions({
      scope, ordered: { A: 10, B: null }, invoiced: { A: 3 }, shipped: { A: 1, B: null }, deliveries: [D1, D2],
      allocations: [{ deliveryId: "d1", sku: "A", quantity: 4 }, { deliveryId: "d2", sku: "A", quantity: 2 }],
      invoicedAgainstDelivery: { [allocKey("d1", "A")]: 3 },
    });
    const a = p.find((x) => x.sku === "A")!;
    expect(a).toMatchObject({ quoted: 10, ordered: 10, allocated: 6, invoiced: 3, shipped: 1, unallocated: 4, remainingInvoiceable: 7, remainingDeliverable: 9, allocatedNotInvoiced: 3 });
    const b = p.find((x) => x.sku === "B")!;
    expect(b).toMatchObject({ ordered: null, invoiced: null, shipped: null, remainingInvoiceable: null, remainingDeliverable: null, cap: 2 });
    expect(b.warnings.join()).toMatch(/unreadable/);
  });
  it("a cancelled delivery's allocation does not count", () => {
    const p = buildQuantityPositions({ scope, deliveries: [{ ...D1, status: "CANCELLED" }], allocations: [{ deliveryId: "d1", sku: "A", quantity: 9 }], invoicedAgainstDelivery: {} });
    expect(p.find((x) => x.sku === "A")!.allocated).toBe(0);
  });
});

describe("allocation validation", () => {
  it("accepts a valid split across two deliveries up to the cap, rejects going over", () => {
    const base = { allocations: [{ deliveryId: "d2", sku: "A", quantity: 6 }] };
    expect(validateAllocationChange(chg({ quantity: 4 }), ctx(base))).toBeNull();
    expect(validateAllocationChange(chg({ quantity: 5 }), ctx(base))).toMatch(/exceed/);
  });
  it("caps at the Sale's ordered quantity when a Sale exists, and refuses SKUs not on the Sale or not in scope", () => {
    expect(validateAllocationChange(chg({ quantity: 6 }), ctx({ ordered: { A: 5 } }))).toMatch(/exceed the ordered quantity 5/);
    expect(validateAllocationChange(chg({ sku: "B", quantity: 1 }), ctx({ ordered: { A: 10 } }))).toMatch(/not on the Cin7 Sale/);
    expect(validateAllocationChange(chg({ sku: "Z" }), ctx())).toMatch(/not in this billing scope/);
  });
  it("needs a reason, a positive-or-zero quantity, and a live delivery", () => {
    expect(validateAllocationChange(chg({ reason: " " }), ctx())).toMatch(/reason/);
    expect(validateAllocationChange(chg({ quantity: -1 }), ctx())).toMatch(/zero or a positive/);
    expect(validateAllocationChange(chg({ deliveryId: "nope" }), ctx())).toMatch(/not found/);
    expect(validateAllocationChange(chg(), ctx({ deliveries: [{ ...D1, status: "CANCELLED" }] }))).toMatch(/cancelled/);
    expect(validateAllocationChange(chg(), ctx({ deliveries: [{ ...D1, status: "DISPATCHED" }] }))).toMatch(/frozen/);
  });
  it("cannot reduce below what is already invoiced against the delivery", () => {
    const c = ctx({ allocations: [{ deliveryId: "d1", sku: "A", quantity: 5 }], invoicedAgainstDelivery: { [allocKey("d1", "A")]: 3 } });
    expect(validateAllocationChange(chg({ quantity: 2 }), c)).toMatch(/already invoiced/);
    expect(validateAllocationChange(chg({ quantity: 3 }), c)).toBeNull();
  });
});

describe("invoice proposal - allocation rule", () => {
  const claimLines = [{ stageName: "Delivery", amountCents: 5_500_000, taxCents: 825_000 }];
  const base = { claimLines, orderLines: [{ sku: "A", description: "Alpha", ordered: 10 }], invoices: [], shipped: { A: 0 }, reserved: {}, scopeSkus: ["A"] };
  it("proposes the allocated quantity BEFORE anything has shipped (the shipped rule would propose none)", () => {
    expect(proposeInvoice(base).lines[0].proposed).toBe(0);
    const p = proposeInvoice({ ...base, allocated: { A: 4 } });
    expect(p.lines[0]).toMatchObject({ eligible: 4, proposed: 4, status: "PROPOSED" });
    expect(validateSelection(p, [{ sku: "A", quantity: 4 }], null)).toBeNull();
  });
  it("is capped by what the Sale still allows: no duplicate physical invoicing", () => {
    const p = proposeInvoice({ ...base, allocated: { A: 4 }, invoices: [{ status: "AUTHORISED", lines: [{ sku: "A", quantity: 8 }] }] });
    expect(p.lines[0]).toMatchObject({ eligible: 2, proposed: 2 });
    const r = proposeInvoice({ ...base, allocated: { A: 4 }, reserved: { A: 9 } });
    expect(r.lines[0]).toMatchObject({ eligible: 1 });
  });
  it("proposes nothing for a SKU with no allocation, and never for a deposit; unreadable invoices stay UNKNOWN", () => {
    expect(proposeInvoice({ ...base, allocated: {} }).lines[0]).toMatchObject({ proposed: 0, status: "NOTHING_ELIGIBLE" });
    expect(proposeInvoice({ ...base, claimLines: [{ stageName: "Deposit", amountCents: 1, taxCents: 0 }], allocated: { A: 4 } }).lines[0].status).toBe("EXCLUDED");
    expect(proposeInvoice({ ...base, allocated: { A: 4 }, invoices: [{ status: "AUTHORISED", lines: null }] }).lines[0].status).toBe("UNKNOWN");
  });
  it("shipped quantity is irrelevant to the allocation rule (unreadable shipment does not block it)", () => {
    expect(proposeInvoice({ ...base, shipped: { A: null }, allocated: { A: 3 } }).lines[0].proposed).toBe(3);
  });
});

describe("posting records drive invoiced-against-delivery", () => {
  it("sums non-failed postings per delivery and SKU; a confirmed no-write failure releases the allocation", () => {
    const m = sumInvoicedAgainstDeliveries([
      { posting_state: "RECONCILED", physical_lines: [{ sku: "A", quantity: 2, deliveryId: "d1" }] },
      { posting_state: "PENDING", physical_lines: [{ sku: "A", quantity: 1, deliveryId: "d1" }] },
      { posting_state: "FAILED_CONFIRMED_NO_WRITE", physical_lines: [{ sku: "A", quantity: 9, deliveryId: "d1" }] },
      { posting_state: "CREATED", physical_lines: [{ sku: "A", quantity: 4 }] },
    ]);
    expect(m).toEqual({ [allocKey("d1", "A")]: 3 });
    expect(allocatedUninvoiced("d1", [{ deliveryId: "d1", sku: "A", quantity: 5 }], m)).toEqual({ A: 2 });
  });
});

describe("delivery store (local tables only)", () => {
  const ORG = "o1", PID = "p1";
  function seed() {
    const db = new FakeDb();
    db.rows("projects").push({ id: PID, org_id: PID && ORG, status: "ACTIVE", baseline_snapshot: { physicalScope: { version: 1, items: [] } } });
    db.rows("project_stages").push({ id: "s1", org_id: ORG, project_id: PID });
    return db;
  }
  it("creates deliveries, allocates with an audit trail, and rejects over-allocation and duplicates", async () => {
    const db = seed();
    const d = await createDelivery(db as never, { orgId: ORG, projectId: PID, actor: "m@x", label: "Truck 1" });
    await expect(createDelivery(db as never, { orgId: ORG, projectId: PID, actor: "m@x", label: "Truck 1" })).rejects.toThrow(/already exists/);
    await expect(setAllocation(db as never, { orgId: ORG, projectId: PID, actor: "m@x", deliveryId: d.id, sku: "NOPE", quantity: 1, reason: "x" })).rejects.toThrow(/not in this billing scope/);
    expect(db.rows("project_delivery_events").map((e) => e.action)).toEqual(["DELIVERY_CREATED"]);
  });
  it("splits a SKU across two deliveries, refuses over-allocation, audits changes, and blocks removal below invoiced", async () => {
    const db = seed();
    db.rows("projects")[0].baseline_snapshot = { lines: [{ lineRef: "L1", sku: "A", description: "Alpha", quantity: 10 }] };
    const a = { orgId: ORG, projectId: PID, actor: "m@x" };
    const t1 = await createDelivery(db as never, { ...a, label: "T1" });
    const t2 = await createDelivery(db as never, { ...a, label: "T2" });
    await setAllocation(db as never, { ...a, deliveryId: t1.id, sku: "A", quantity: 6, reason: "first load" });
    await setAllocation(db as never, { ...a, deliveryId: t2.id, sku: "A", quantity: 4, reason: "rest" });
    await expect(setAllocation(db as never, { ...a, deliveryId: t2.id, sku: "A", quantity: 5, reason: "too many" })).rejects.toThrow(/exceed/);
    await setAllocation(db as never, { ...a, deliveryId: t1.id, sku: "A", quantity: 5, reason: "one left behind" });
    const reg = await loadDeliveryRegister(db as never, ORG, PID);
    expect(reg.positions.find((x) => x.sku === "A")).toMatchObject({ quoted: 10, allocated: 9, unallocated: 1 });
    expect(db.rows("project_delivery_events").filter((e) => e.sku === "A").map((e) => [e.action, e.from_quantity, e.to_quantity])).toEqual([["ALLOCATION_SET", 0, 6], ["ALLOCATION_SET", 0, 4], ["ALLOCATION_SET", 6, 5]]);
    db.rows("project_claim_cin7_postings").push({ org_id: ORG, project_id: PID, posting_state: "RECONCILED", physical_lines: [{ sku: "A", quantity: 5, deliveryId: t1.id }] });
    await expect(setAllocation(db as never, { ...a, deliveryId: t1.id, sku: "A", quantity: 0, reason: "remove" })).rejects.toThrow(/already invoiced/);
    await expect(setDeliveryStatus(db as never, { ...a, deliveryId: t1.id, status: "CANCELLED", reason: "x" })).rejects.toThrow(/invoiced products/);
    expect(await loadDeliveryEligibility(db as never, ORG, PID, t2.id)).toMatchObject({ allocated: { A: 4 } });
  });
  it("records milestone confirmations with evidence; refuses an empty note and a foreign stage", async () => {
    const db = seed();
    const c = await confirmMilestone(db as never, { orgId: ORG, projectId: PID, stageId: "s1", actor: "m@x", note: "90% delivered, signed POD", evidenceRef: "POD-1" });
    expect(c).toMatchObject({ stage_id: "s1", confirmed_by_email: "m@x", evidence_ref: "POD-1" });
    await expect(confirmMilestone(db as never, { orgId: ORG, projectId: PID, stageId: "s1", actor: "m@x", note: " " })).rejects.toThrow(/Describe/);
    await expect(confirmMilestone(db as never, { orgId: ORG, projectId: PID, stageId: "zz", actor: "m@x", note: "n" })).rejects.toThrow(/not found/);
    expect((await listMilestoneConfirmations(db as never, ORG, PID))).toHaveLength(1);
  });
  it("cancelling releases allocations; an unknown delivery and illegal transitions are refused", async () => {
    const db = seed();
    const d = await createDelivery(db as never, { orgId: ORG, projectId: PID, actor: "m@x", label: "T" });
    await setDeliveryStatus(db as never, { orgId: ORG, projectId: PID, actor: "m@x", deliveryId: d.id, status: "CANCELLED", reason: "plan changed" });
    await expect(setDeliveryStatus(db as never, { orgId: ORG, projectId: PID, actor: "m@x", deliveryId: d.id, status: "LOADING", reason: "r" })).rejects.toThrow(/cannot become/);
    await expect(loadDeliveryEligibility(db as never, ORG, PID, d.id)).rejects.toThrow(/cancelled/);
    const reg = await loadDeliveryRegister(db as never, ORG, PID);
    expect(reg.deliveries).toHaveLength(1);
  });
});
