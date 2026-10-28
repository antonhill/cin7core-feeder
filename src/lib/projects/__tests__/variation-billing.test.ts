import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, recordProgress, submitClaimForApproval } from "../project-store";
import { approveVariation, raiseVariation } from "../variation-store";
import { amendVariationSchedule, createVariationBillingProject, listVariationStages, loadConsolidatedProject, saveDraftSchedule } from "../variation-billing-store";
import { defaultVariationSchedule, scheduleFromPercents, scheduleToStages, splitCents, validateVariationSchedule } from "../variation-schedule";
import { linkCin7Sale, postClaimToCin7, type Cin7Port, type Cin7SaleView, type InvoiceOutcome, type InvoiceRequest, type WriteGates } from "../cin7-posting-store";
import { POST_CONFIRMATION_TEXT } from "../cin7-posting";

const ORG = "org-a";
const MGR = { isManager: true };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };
const sum = (a: number[]) => a.reduce((n, x) => n + x, 0);

describe("schedule maths (twin of variation_stage_cents in migration 0105)", () => {
  it("matches the SQL worked examples exactly", () => {
    expect(splitCents(1_000_001, [3333, 3333, 3334])).toEqual([333_300, 333_300, 333_401]);
    expect(splitCents(100, [3333, 3333, 3334])).toEqual([33, 33, 34]);
    expect(splitCents(1, [5000, 5000])).toEqual([1, 0]); // tie -> earliest stage
    expect(splitCents(48_000_000, [10_000])).toEqual([48_000_000]);
    expect(sum(splitCents(999_999_999, [1, 2, 9997]))).toBe(999_999_999);
  });
  it("always sums to the amount, including near MAX_CENTS where amount x bps exceeds 2^53", () => {
    for (const amount of [0, 1, 7, 99_999, 123_456_789, 999_999_999_999]) {
      for (const bps of [[10_000], [5000, 5000], [3333, 3333, 3334], [1, 9999], [1234, 4321, 4445]]) {
        const out = splitCents(amount, bps);
        expect(sum(out)).toBe(amount);
        expect(out.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
      }
    }
  });
  it("is deterministic regardless of call count", () => {
    const a = splitCents(777_777, [3333, 3333, 3334]);
    expect(splitCents(777_777, [3333, 3333, 3334])).toEqual(a);
  });
  it("validates: totals exactly 100%, names unique and non-blank, whole bps 1..10000", () => {
    expect(validateVariationSchedule(defaultVariationSchedule())).toEqual({ ok: true });
    expect(validateVariationSchedule([])).toMatchObject({ ok: false });
    expect(validateVariationSchedule([{ name: "A", bps: 5000 }, { name: "B", bps: 4999 }])).toMatchObject({ ok: false, error: expect.stringMatching(/99\.99%/) });
    expect(validateVariationSchedule([{ name: "A", bps: 5000 }, { name: "a", bps: 5000 }])).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
    expect(validateVariationSchedule([{ name: " ", bps: 10_000 }])).toMatchObject({ ok: false });
    expect(validateVariationSchedule([{ name: "A", bps: 0 }, { name: "B", bps: 10_000 }])).toMatchObject({ ok: false });
    expect(validateVariationSchedule([{ name: "A", bps: 5000.5 }, { name: "B", bps: 4999.5 }])).toMatchObject({ ok: false });
  });
  it("parses user percentages and rejects non-numeric input", () => {
    expect(scheduleFromPercents([{ name: "Order", percent: "30" }, { name: "Delivery", percent: "70" }])).toEqual([{ name: "Order", bps: 3000 }, { name: "Delivery", bps: 7000 }]);
    expect(() => scheduleFromPercents([{ name: "x", percent: "abc" }])).toThrow();
    expect(() => scheduleToStages(100, [{ name: "A", bps: 5000 }])).toThrow(/100%/);
  });
});

async function setup() {
  const db = new FakeDb();
  const parent = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "Grower" });
  return { db, parent };
}
async function approvedVariation(ctx: Awaited<ReturnType<typeof setup>>, amountCents = 1_000_001, stages = [{ name: "Order", bps: 3333 }, { name: "Delivery", bps: 3333 }, { name: "Commissioning", bps: 3334 }]) {
  const { variationId, code } = await raiseVariation(ctx.db as never, ORG, "e@x", { projectId: ctx.parent, title: "Ventilation", description: "", amountCents });
  await saveDraftSchedule(ctx.db as never, ORG, ctx.parent, variationId, stages);
  await approveVariation(ctx.db as never, ORG, "m@x", ctx.parent, variationId);
  return { variationId, code };
}

describe("variation schedule persistence", () => {
  it("a new variation starts with the default single 100% stage; DRAFT schedules are editable, validated, replaced", async () => {
    const ctx = await setup();
    const { variationId } = await raiseVariation(ctx.db as never, ORG, "e@x", { projectId: ctx.parent, title: "T", description: "", amountCents: 500_000 });
    expect((await listVariationStages(ctx.db as never, ORG, variationId)).map((s) => [s.name, s.bps])).toEqual([["Variation", 10_000]]);
    expect(await err(saveDraftSchedule(ctx.db as never, ORG, ctx.parent, variationId, [{ name: "A", bps: 9000 }]))).toMatch(/100%/);
    await saveDraftSchedule(ctx.db as never, ORG, ctx.parent, variationId, [{ name: "A", bps: 4000 }, { name: "B", bps: 6000 }]);
    expect((await listVariationStages(ctx.db as never, ORG, variationId)).map((s) => s.bps)).toEqual([4000, 6000]);
  });
  it("a schedule is frozen once the variation is approved (draft save refused)", async () => {
    const ctx = await setup();
    const { variationId } = await approvedVariation(ctx);
    expect(await err(saveDraftSchedule(ctx.db as never, ORG, ctx.parent, variationId, defaultVariationSchedule()))).toMatch(/frozen/);
  });
});

describe("variation billing project", () => {
  it("creates one ACTIVE billing project with cents summing to the approved amount; idempotent; parent untouched", async () => {
    const ctx = await setup();
    const { variationId, code } = await approvedVariation(ctx);
    const before = structuredClone(ctx.db.rows("projects").find((r) => r.id === ctx.parent));
    const r = await createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId });
    expect(r.created).toBe(true);
    const child = (await loadProjectView(ctx.db as never, ORG, r.billingProjectId))!;
    expect(child.project).toMatchObject({ project_reference: `PRJ-NQ-Q-0001-${code}`, status: "ACTIVE", original_contract_cents: 1_000_001, billing_scope: "VARIATION", parent_project_id: ctx.parent, variation_id: variationId });
    expect(child.stages.map((s) => s.valueCents)).toEqual([333_300, 333_300, 333_401]);
    expect(child.commercial.scheduleBalanced).toBe(true);
    expect(await createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId })).toEqual({ billingProjectId: r.billingProjectId, created: false });
    expect(ctx.db.rows("projects").filter((p) => p.variation_id === variationId)).toHaveLength(1);
    expect(ctx.db.rows("projects").find((p) => p.id === ctx.parent)).toEqual(before);
  });
  it("copies the parent's customer, tax and instance; refuses non-managers, DRAFT variations and legacy approved variations with no schedule", async () => {
    const ctx = await setup();
    const { variationId } = await approvedVariation(ctx);
    expect(await err(createVariationBillingProject(ctx.db as never, { isManager: false }, "x", { orgId: ORG, projectId: ctx.parent, variationId }))).toMatch(/manager/);
    const r = await createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId });
    const parent = ctx.db.rows("projects").find((p) => p.id === ctx.parent)!;
    const child = ctx.db.rows("projects").find((p) => p.id === r.billingProjectId)!;
    for (const k of ["customer_name", "cin7_customer_id", "tax_rate_bps", "tax_inclusive", "currency", "tax_rule", "instance_id"]) expect(child[k]).toEqual(parent[k]);
    const draft = await raiseVariation(ctx.db as never, ORG, "e@x", { projectId: ctx.parent, title: "D", description: "", amountCents: 100 });
    expect(await err(createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId: draft.variationId }))).toMatch(/APPROVED/);
    // a variation approved before schedules existed (V001 shape): no schedule rows
    const legacy = await raiseVariation(ctx.db as never, ORG, "e@x", { projectId: ctx.parent, title: "Legacy", description: "", amountCents: 48_000_000 });
    ctx.db.tables["project_variation_stages"] = ctx.db.rows("project_variation_stages").filter((s) => s.variation_id !== legacy.variationId);
    await approveVariation(ctx.db as never, ORG, "m@x", ctx.parent, legacy.variationId);
    expect(await err(createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId: legacy.variationId }))).toMatch(/no billing schedule/);
    expect(ctx.db.rows("projects").filter((p) => p.variation_id === legacy.variationId)).toHaveLength(0); // never created automatically
  });
  it("a variation cannot bill beyond its approved value: stage claims are capped by the unmodified engine", async () => {
    const ctx = await setup();
    const { variationId } = await approvedVariation(ctx, 48_000_000, defaultVariationSchedule());
    const { billingProjectId } = await createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId });
    const v = (await loadProjectView(ctx.db as never, ORG, billingProjectId))!;
    expect(v.stages).toHaveLength(1);
    await recordProgress(ctx.db as never, ORG, "x@x", { projectId: billingProjectId, stageId: v.stages[0].id, reportedPct: "100", approvedPct: "100", comment: "done" });
    const { claimId } = await createClaimDraft(ctx.db as never, ORG, "x@x", billingProjectId);
    await submitClaimForApproval(ctx.db as never, ORG, billingProjectId, claimId);
    await approveClaim(ctx.db as never, ORG, "mgr@x", billingProjectId, claimId);
    const after = (await loadProjectView(ctx.db as never, ORG, billingProjectId))!;
    expect(after.commercial.committedCents).toBe(48_000_000);
    expect(after.commercial.claimableCents).toBe(0);
    expect(await err(createClaimDraft(ctx.db as never, ORG, "x@x", billingProjectId))).toBeDefined(); // nothing left to claim
  });
});

describe("controlled amendment", () => {
  it("requires a manager, a reason, a valid schedule and an APPROVED variation; then calls the audited database function", async () => {
    const ctx = await setup();
    const { variationId } = await approvedVariation(ctx);
    const base = { orgId: ORG, projectId: ctx.parent, variationId, stages: [{ name: "All", bps: 10_000 }], reason: "customer wants one invoice" };
    expect(await err(amendVariationSchedule(ctx.db as never, { isManager: false }, "x", base))).toMatch(/manager/);
    expect(await err(amendVariationSchedule(ctx.db as never, MGR, "m@x", { ...base, reason: " " }))).toMatch(/reason/);
    expect(await err(amendVariationSchedule(ctx.db as never, MGR, "m@x", { ...base, stages: [{ name: "x", bps: 9000 }] }))).toMatch(/100%/);
    const draft = await raiseVariation(ctx.db as never, ORG, "e@x", { projectId: ctx.parent, title: "D", description: "", amountCents: 100 });
    expect(await err(amendVariationSchedule(ctx.db as never, MGR, "m@x", { ...base, variationId: draft.variationId }))).toMatch(/APPROVED/);
    expect(ctx.db.rpcCalls).toHaveLength(0);
    ctx.db.rpcHandlers["amend_variation_schedule"] = () => ({ error: null });
    await amendVariationSchedule(ctx.db as never, MGR, "m@x", base);
    expect(ctx.db.rpcCalls[0]).toEqual({ fn: "amend_variation_schedule", args: { p_org: ORG, p_variation: variationId, p_stages: [{ name: "All", bps: 10_000 }], p_reason: "customer wants one invoice", p_email: "m@x" } });
  });
  it("surfaces the database refusal (claims already exist)", async () => {
    const ctx = await setup();
    const { variationId } = await approvedVariation(ctx);
    ctx.db.rpcHandlers["amend_variation_schedule"] = () => ({ error: { message: "the billing project already has claims or progress" } });
    expect(await err(amendVariationSchedule(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId, stages: [{ name: "All", bps: 10_000 }], reason: "r" }))).toMatch(/already has claims/);
  });
});

describe("consolidation", () => {
  it("sums BASE and variation billing projects and lists approved variations that are not yet billable", async () => {
    const ctx = await setup();
    const a = await approvedVariation(ctx, 1_000_000, defaultVariationSchedule());
    await approvedVariation(ctx, 480_000_00, defaultVariationSchedule()); // V002 approved, no billing project
    await createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId: a.variationId });
    const c = (await loadConsolidatedProject(ctx.db as never, ORG, ctx.parent))!;
    expect(c.scopes.map((s) => [s.scope, s.variationCode, s.contractCents])).toEqual([["BASE", null, 1_000_000_000], ["VARIATION", "V001", 1_000_000]]);
    expect(c.totals.contractCents).toBe(1_000_000_000 + 1_000_000);
    expect(c.unbilledApprovedVariations).toEqual([{ id: expect.any(String), code: "V002", amountCents: 48_000_000 }]);
    // asking for a variation billing project as if it were a project is refused
    expect(await err(loadConsolidatedProject(ctx.db as never, ORG, c.scopes[1].projectId))).toMatch(/BASE project/);
  });
});

// ── claims route to the variation's OWN Sale ───────────────────────────────────
const SALE_BASE = "4fe3d99c-241d-4404-8795-4c448842108b";
const SALE_VAR = "d99db61e-2af5-497b-81b2-e5610c251056";
class Port implements Cin7Port {
  sales: Record<string, Cin7SaleView> = {
    [SALE_BASE]: { id: SALE_BASE, saleNumber: "SO-1", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [] },
    [SALE_VAR]: { id: SALE_VAR, saleNumber: "SO-2", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [] },
  };
  created: InvoiceRequest[] = [];
  async fetchSale(id: string) { return structuredClone(this.sales[id]); }
  async createInvoice(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.created.push(req);
    const sub = req.charges.reduce((n, c) => n + c.priceExVat, 0); const tax = req.charges.reduce((n, c) => n + c.taxAmount, 0);
    return { kind: "created", invoiceNumber: `INV-${this.created.length}`, taskId: `t${this.created.length}`, status: "DRAFT", totalBeforeTax: sub, tax, total: sub + tax };
  }
}
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };

describe("claims post to the right Sale", () => {
  let ctx: Awaited<ReturnType<typeof setup>>; let port: Port;
  beforeEach(async () => { ctx = await setup(); port = new Port(); });
  it("a variation claim posts to the variation's Sale with the variation's own memo; the base Sale is never used", async () => {
    const { variationId } = await approvedVariation(ctx, 48_000_000, defaultVariationSchedule());
    const { billingProjectId } = await createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId });
    await linkCin7Sale(ctx.db as never, port, ON, "m@x", { orgId: ORG, projectId: ctx.parent, instanceId: "i", saleId: SALE_BASE, revenueAccount: "200" });
    const vlink = await linkCin7Sale(ctx.db as never, port, ON, "m@x", { orgId: ORG, projectId: billingProjectId, instanceId: "i", saleId: SALE_VAR, revenueAccount: "200" });
    expect(vlink).toMatchObject({ project_id: billingProjectId, cin7_sale_id: SALE_VAR });
    expect(ctx.db.rows("project_cin7_sale_links").map((l) => l.sale_role)).toEqual([undefined, "VARIATION"]); // BASE rows stay shaped as before 0105

    const v = (await loadProjectView(ctx.db as never, ORG, billingProjectId))!;
    await recordProgress(ctx.db as never, ORG, "x@x", { projectId: billingProjectId, stageId: v.stages[0].id, reportedPct: "100", approvedPct: "100", comment: "c" });
    const { claimId } = await createClaimDraft(ctx.db as never, ORG, "x@x", billingProjectId);
    await submitClaimForApproval(ctx.db as never, ORG, billingProjectId, claimId);
    await approveClaim(ctx.db as never, ORG, "mgr@x", billingProjectId, claimId);
    const r = await postClaimToCin7(ctx.db as never, port, ON, "m@x", { orgId: ORG, projectId: billingProjectId, claimId, confirmation: POST_CONFIRMATION_TEXT });
    expect(r.state).toBe("CREATED");
    expect(port.created).toHaveLength(1);
    expect(port.created[0].saleId).toBe(SALE_VAR);
    expect(port.created[0].memo).toMatch(/^NEWQUIP-PROJECTS:PRJ-NQ-Q-0001-V001:/);
    // R480,000 ex VAT: VAT is a monetary amount of R72,000, not a rate
    expect(port.created[0].charges.reduce((n, c) => n + c.taxAmount, 0)).toBe(72_000);
  });
  it("a claim of one project cannot be posted through another project's route", async () => {
    const { variationId } = await approvedVariation(ctx, 48_000_000, defaultVariationSchedule());
    const { billingProjectId } = await createVariationBillingProject(ctx.db as never, MGR, "m@x", { orgId: ORG, projectId: ctx.parent, variationId });
    await linkCin7Sale(ctx.db as never, port, ON, "m@x", { orgId: ORG, projectId: billingProjectId, instanceId: "i", saleId: SALE_VAR, revenueAccount: "200" });
    const v = (await loadProjectView(ctx.db as never, ORG, billingProjectId))!;
    await recordProgress(ctx.db as never, ORG, "x@x", { projectId: billingProjectId, stageId: v.stages[0].id, reportedPct: "100", approvedPct: "100", comment: "c" });
    const { claimId } = await createClaimDraft(ctx.db as never, ORG, "x@x", billingProjectId);
    await submitClaimForApproval(ctx.db as never, ORG, billingProjectId, claimId);
    await approveClaim(ctx.db as never, ORG, "mgr@x", billingProjectId, claimId);
    // via the BASE project (which has no link at all, and does not own this claim)
    expect(await err(postClaimToCin7(ctx.db as never, port, ON, "m@x", { orgId: ORG, projectId: ctx.parent, claimId, confirmation: POST_CONFIRMATION_TEXT }))).toBeDefined();
    expect(port.created).toHaveLength(0);
  });
});
