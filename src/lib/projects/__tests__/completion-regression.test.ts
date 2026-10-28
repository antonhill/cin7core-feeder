// REGRESSION for Phases A-C of the completion programme, run on the real R10m demo quotation (pricing engine + workbook snapshot) and the real
// stores over the in-memory database. Cin7 is never reached.
import { describe, expect, it } from "vitest";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { buildAcceptedBaseline } from "@/newquip/quote/baseline";
import { POC_SIX_STAGE_SCHEDULE, resolveScheduleChoice } from "@/newquip/quote/billing-schedule";
import { quoteToProjectBaseline } from "@/newquip/quote/to-project";
import { FakeDb } from "./fake-db";
import { createClaimDraft, createProjectFromBaseline, loadProjectView, previewClaim, recordProgress } from "../project-store";
import { confirmMilestone, createDelivery, loadDeliveryEligibility, setAllocation, setDeliveryStatus } from "../delivery-allocation-store";
import { proposeInvoice, validateSelection } from "../invoice-proposal";
import { buildCreationPlan } from "../cin7-sale-creation";
import { raiseVariation, approveVariation } from "../variation-store";
import { createVariationBillingProject, saveDraftSchedule } from "../variation-billing-store";
import { defaultVariationSchedule } from "../variation-schedule";
import { effectiveScope, scopeFromSnapshot } from "../product-scope";
import { resolveVariationProducts } from "../catalogue-search";

const ORG = "org-nq";
const R = (n: number) => n * 100;
const APPROVALS = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };
const ctx = (withholdCost: boolean) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost });
const draft = applyDemoDefaults(emptyDraft()).draft;
const approved = buildAcceptedBaseline({ quoteRef: "NQ-Q-0001", revision: 1, draft, evaluation: evaluateDraft(draft, ctx(true)), marginEvaluation: evaluateDraft(draft, ctx(false)), approvals: APPROVALS });
const mkProject = async (db: FakeDb, schedule?: Parameters<typeof quoteToProjectBaseline>[3], ref = "PRJ-NQ-Q-0001") =>
  createProjectFromBaseline(db as never, ORG, "m@x", quoteToProjectBaseline(approved.baseline, approved.hash, "q1", schedule), { reference: ref, name: "Demo" });

describe("Phase A - commercial billing", () => {
  it("a NEW project defaults to 40/55/5: R4m / R5.5m / R500k of the R10m quote, and the Cin7 Sale plan carries those charges", async () => {
    const db = new FakeDb(); const id = await mkProject(db);
    const v = (await loadProjectView(db as never, ORG, id))!;
    expect(v.stages.map((s) => [s.name, s.valueCents])).toEqual([["Deposit", R(4_000_000)], ["Delivery", R(5_500_000)], ["Installation", R(500_000)]]);
    expect(v.commercial.scheduleBalanced).toBe(true);
    const plan = buildCreationPlan({ projectRef: "PRJ-NQ-Q-0001", customerName: "C", location: "MSTR", taxRule: "Standard Rate Sales", taxRateBps: 1500, revenueAccount: "200", saleOrderDate: "2026-10-28", contractCents: v.commercial.originalContractCents, stages: v.stages.map((s) => ({ name: s.name, valueCents: s.valueCents })), physicalLines: [] } as never);
    expect(plan.ok && plan.plan.charges.map((c) => [c.amountCents, c.taxCents])).toEqual([[R(4_000_000), R(600_000)], [R(5_500_000), R(825_000)], [R(500_000), R(75_000)]]);
    expect(plan.ok && plan.plan.contractCents + plan.plan.taxCents).toBe(plan.ok ? plan.plan.totalCents : -1);
    expect(plan.ok && plan.plan.charges.map((c) => c.description.toLowerCase()).join("|")).toMatch(/deposit.*delivery.*installation/);
  });
  it("six-stage and custom schedules are selectable; a bad custom schedule is refused; an existing project keeps its stages", async () => {
    const db = new FakeDb();
    const legacy = await mkProject(db, POC_SIX_STAGE_SCHEDULE, "PRJ-OLD");
    const custom = resolveScheduleChoice({ preset: "CUSTOM", stages: [{ name: "Deposit", percent: "30" }, { name: "Delivery 1", percent: "30" }, { name: "Delivery 2", percent: "30" }, { name: "Install", percent: "10" }] });
    if (!custom.ok) throw new Error("custom must resolve");
    const c = await mkProject(db, custom.schedule, "PRJ-CUSTOM");
    expect((await loadProjectView(db as never, ORG, legacy))!.stages).toHaveLength(6);
    expect((await loadProjectView(db as never, ORG, c))!.stages.map((s) => s.valueCents)).toEqual([R(3_000_000), R(3_000_000), R(3_000_000), R(1_000_000)]);
    expect(resolveScheduleChoice({ preset: "CUSTOM", stages: [{ name: "A", percent: "60" }, { name: "B", percent: "30" }] }).ok).toBe(false);
    expect((await loadProjectView(db as never, ORG, legacy))!.stages).toHaveLength(6); // creating other projects changed nothing
  });
  it("claim caps hold at every stage; milestone confirmation is informational (claims work without it) and independent of physical progress", async () => {
    const db = new FakeDb(); const id = await mkProject(db);
    const v = (await loadProjectView(db as never, ORG, id))!;
    const dep = v.stages.find((s) => s.name === "Deposit")!;
    await recordProgress(db as never, ORG, "m@x", { projectId: id, stageId: dep.id, reportedPct: "100", approvedPct: "100", comment: "contract signed" });
    const preview = await previewClaim(db as never, ORG, id);
    expect(preview.calc.subtotalCents).toBe(R(4_000_000)); expect(preview.calc.taxCents).toBe(R(600_000));
    await createClaimDraft(db as never, ORG, "m@x", id); // no confirmation recorded: not a gate
    expect(db.rows("project_milestone_confirmations")).toHaveLength(0);
    const before = (await loadProjectView(db as never, ORG, id))!.commercial;
    const inv = await mkConfirm(db, id, dep.id);
    expect(inv.stage_id).toBe(dep.id);
    const after = (await loadProjectView(db as never, ORG, id))!;
    expect(after.commercial).toEqual(before); // confirmation did not move a cent, claim or progress figure
    expect(after.claims).toHaveLength(1);
  });
});
const mkConfirm = (db: FakeDb, id: string, stageId: string) => confirmMilestone(db as never, { orgId: ORG, projectId: id, stageId, actor: "m@x", note: "Contract approved", evidenceRef: "PO-1" });

describe("Phase B - delivery allocation", () => {
  const claimLines = [{ stageName: "Delivery", amountCents: R(5_500_000), taxCents: R(825_000) }];
  const order = [{ sku: "A", description: "Alpha", ordered: 10 }];
  it("products are proposed from the allocation while goods are still LOADING, independent of any shipment; a stock shortage is irrelevant", async () => {
    const db = new FakeDb(); const id = await mkProject(db);
    db.rows("projects").find((p) => p.id === id)!.baseline_snapshot = { lines: [{ lineRef: "L", sku: "A", description: "Alpha", quantity: 10 }] };
    const a = { orgId: ORG, projectId: id, actor: "m@x" };
    const d1 = await createDelivery(db as never, { ...a, label: "Truck 1" });
    await setAllocation(db as never, { ...a, deliveryId: d1.id, sku: "A", quantity: 4, reason: "first load" });
    await setDeliveryStatus(db as never, { ...a, deliveryId: d1.id, status: "LOADING", reason: "loading now" });
    const { allocated } = await loadDeliveryEligibility(db as never, ORG, id, d1.id);
    const p = proposeInvoice({ claimLines, orderLines: order, invoices: [], shipped: { A: 0 }, reserved: {}, scopeSkus: ["A"], allocated });
    expect(p.lines[0]).toMatchObject({ proposed: 4, shipped: 0, status: "PROPOSED" });
    expect(validateSelection(p, [{ sku: "A", quantity: 4 }], null)).toBeNull();
    // a stock shortage plays no part: the Sale plan has no stock input and quote/project/Sale creation never read stock
    expect(Object.keys(p)).not.toContain("stock");
  });
  it("no duplicate physical invoicing across deliveries and claims: a posted delivery's quantity is not proposed again", async () => {
    const db = new FakeDb(); const id = await mkProject(db);
    db.rows("projects").find((p) => p.id === id)!.baseline_snapshot = { lines: [{ lineRef: "L", sku: "A", description: "Alpha", quantity: 10 }] };
    const a = { orgId: ORG, projectId: id, actor: "m@x" };
    const d1 = await createDelivery(db as never, { ...a, label: "T1" }); const d2 = await createDelivery(db as never, { ...a, label: "T2" });
    await setAllocation(db as never, { ...a, deliveryId: d1.id, sku: "A", quantity: 6, reason: "r" });
    await setAllocation(db as never, { ...a, deliveryId: d2.id, sku: "A", quantity: 4, reason: "r" });
    db.rows("project_claim_cin7_postings").push({ org_id: ORG, project_id: id, posting_state: "RECONCILED", physical_lines: [{ sku: "A", quantity: 6, deliveryId: d1.id }] });
    expect((await loadDeliveryEligibility(db as never, ORG, id, d1.id)).allocated).toEqual({}); // T1 fully invoiced
    expect((await loadDeliveryEligibility(db as never, ORG, id, d2.id)).allocated).toEqual({ A: 4 });
    // and even if the allocation is more generous than the Sale, the Sale's remaining quantity caps the proposal
    const capped = proposeInvoice({ claimLines, orderLines: order, invoices: [{ status: "AUTHORISED", lines: [{ sku: "A", quantity: 9 }] }], shipped: {}, reserved: {}, scopeSkus: [], allocated: { A: 4 } });
    expect(capped.lines[0].proposed).toBe(1);
  });
  it("BASE and variation allocations are independent (keyed by billing project)", async () => {
    const db = new FakeDb(); const parent = await mkProject(db);
    db.rows("projects").find((p) => p.id === parent)!.baseline_snapshot = { lines: [{ lineRef: "L", sku: "A", description: "Alpha", quantity: 2 }] };
    const { variationId } = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "V", description: "", amountCents: R(5_000) });
    await saveDraftSchedule(db as never, ORG, parent, variationId, defaultVariationSchedule());
    await approveVariation(db as never, ORG, "m@x", parent, variationId);
    const child = await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId: parent, variationId, products: [{ sku: "A", description: "Alpha", quantity: 3 }] });
    const dB = await createDelivery(db as never, { orgId: ORG, projectId: parent, actor: "m@x", label: "Truck 1" });
    const dV = await createDelivery(db as never, { orgId: ORG, projectId: child.billingProjectId, actor: "m@x", label: "Truck 1" }); // same label, other scope: allowed
    await setAllocation(db as never, { orgId: ORG, projectId: parent, actor: "m@x", deliveryId: dB.id, sku: "A", quantity: 2, reason: "r" });
    await setAllocation(db as never, { orgId: ORG, projectId: child.billingProjectId, actor: "m@x", deliveryId: dV.id, sku: "A", quantity: 3, reason: "r" });
    await expect(setAllocation(db as never, { orgId: ORG, projectId: parent, actor: "m@x", deliveryId: dB.id, sku: "A", quantity: 3, reason: "over" })).rejects.toThrow(/exceed/); // base cap is 2, not 5
    expect((await loadDeliveryEligibility(db as never, ORG, parent, dB.id)).allocated).toEqual({ A: 2 });
    expect((await loadDeliveryEligibility(db as never, ORG, child.billingProjectId, dV.id)).allocated).toEqual({ A: 3 });
    await expect(loadDeliveryEligibility(db as never, ORG, parent, dV.id)).rejects.toThrow(/not found/); // a variation's delivery is invisible from the base scope
  });
});

describe("Phase C - variations", () => {
  it("a service-only variation needs no products and invents no SKU; products are validated against the catalogue (stock irrelevant)", async () => {
    const db = new FakeDb(); const parent = await mkProject(db);
    const { variationId } = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "Extra installation", description: "", amountCents: R(5_000) });
    await saveDraftSchedule(db as never, ORG, parent, variationId, defaultVariationSchedule());
    await approveVariation(db as never, ORG, "m@x", parent, variationId);
    const none = await resolveVariationProducts(db as never, ORG, []);
    const child = await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId: parent, variationId, products: none });
    const snap = db.rows("projects").find((p) => p.id === child.billingProjectId)!.baseline_snapshot;
    expect(effectiveScope(scopeFromSnapshot(snap)).lines).toEqual([]);
    db.rows("products").push({ org_id: ORG, sku: "KNQPP014", name: "Vent panel", cin7_type: "Stock", active: true, status: "Active" });
    db.rows("product_availability").push({ org_id: ORG, product_sku: "KNQPP014", location: "MSTR", available: 0 });
    expect(await resolveVariationProducts(db as never, ORG, [{ sku: "KNQPP014", quantity: 1 }])).toEqual([{ sku: "KNQPP014", description: "Vent panel", quantity: 1 }]);
    await expect(resolveVariationProducts(db as never, ORG, [{ sku: "KNQPP01", quantity: 1 }])).rejects.toThrow(/not in the synced Cin7 catalogue/);
  });
});
