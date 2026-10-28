// ARCHITECTURE INVARIANTS for "one customer-facing project, BASE + variation billing scopes" (post-integration validation).
import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { createProjectFromBaseline, listProjectViews, loadProjectView, recordProgress, createClaimDraft, submitClaimForApproval, approveClaim } from "../project-store";
import { approveVariation, raiseVariation } from "../variation-store";
import { createVariationBillingProject, loadConsolidatedProject, saveDraftSchedule } from "../variation-billing-store";
import { defaultVariationSchedule } from "../variation-schedule";
import { isCustomerFacingProject } from "../project-view";
import { contractPosition } from "../variations";

const ORG = "org-a";
const MGR = { isManager: true };
const R = (n: number) => n * 100;
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

async function world() {
  const db = new FakeDb();
  const parent = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "Grower" });
  const mk = async (amount: number, sched = defaultVariationSchedule()) => {
    const { variationId } = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "V", description: "", amountCents: amount });
    await saveDraftSchedule(db as never, ORG, parent, variationId, sched);
    await approveVariation(db as never, ORG, "m@x", parent, variationId);
    return variationId;
  };
  return { db, parent, mk };
}

describe("one customer-facing project", () => {
  it("lists exactly one project however many variations are billed; billing projects are internal", async () => {
    const { db, parent, mk } = await world();
    for (const v of [await mk(R(480_000)), await mk(R(120_000), [{ name: "Order", bps: 4000 }, { name: "Delivery", bps: 6000 }])]) await createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: v });
    expect(db.rows("projects")).toHaveLength(3); // base + 2 internal billing projects
    const visible = (await listProjectViews(db as never, ORG)).filter(isCustomerFacingProject);
    expect(visible.map((v) => v.project.id)).toEqual([parent]);
  });
});

describe("no duplicate commitments or revenue; consolidated values are right", () => {
  it("contract = original + billed variations; unbilled approved variations are listed, never double counted or lost", async () => {
    const { db, parent, mk } = await world();
    const v1 = await mk(R(480_000)); await mk(R(120_000)); // V002 approved but not billed
    await createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: v1 });
    const c = (await loadConsolidatedProject(db as never, ORG, parent))!;
    const base = c.base;
    expect(base.commercial.revisedContractCents).toBe(R(10_000_000) + R(480_000) + R(120_000)); // the revised contract counts every approved variation ONCE
    expect(c.totals.contractCents).toBe(R(10_000_000) + R(480_000)); // billable scopes only
    expect(c.totals.contractCents + c.unbilledApprovedVariations.reduce((n, v) => n + v.amountCents, 0)).toBe(base.commercial.revisedContractCents);
    expect(c.scopes.filter((s) => s.scope === "VARIATION")).toHaveLength(1);
    // the position the engine computes from approved variations is the same number
    expect(contractPosition(R(10_000_000), base.variations).revisedContractCents).toBe(base.commercial.revisedContractCents);
  });
  it("a variation's claims live ONLY on its own scope: the BASE scope's claims, commitments and stages are unchanged by variation billing", async () => {
    const { db, parent, mk } = await world();
    const base = (await loadProjectView(db as never, ORG, parent))!;
    await recordProgress(db as never, ORG, "x@x", { projectId: parent, stageId: base.stages[0].id, reportedPct: "100", approvedPct: "100", comment: "c" });
    const { claimId } = await createClaimDraft(db as never, ORG, "x@x", parent);
    await submitClaimForApproval(db as never, ORG, parent, claimId); await approveClaim(db as never, ORG, "mgr@x", parent, claimId);
    const claimBefore = structuredClone(db.rows("project_claims").find((r) => r.id === claimId));
    const stagesBefore = structuredClone(db.rows("project_stages").filter((r) => r.project_id === parent));

    const v = await mk(R(480_000));
    const { billingProjectId } = await createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: v });
    const child = (await loadProjectView(db as never, ORG, billingProjectId))!;
    await recordProgress(db as never, ORG, "x@x", { projectId: billingProjectId, stageId: child.stages[0].id, reportedPct: "100", approvedPct: "100", comment: "c" });
    const vc = await createClaimDraft(db as never, ORG, "x@x", billingProjectId);
    await submitClaimForApproval(db as never, ORG, billingProjectId, vc.claimId); await approveClaim(db as never, ORG, "mgr@x", billingProjectId, vc.claimId);

    expect(db.rows("project_claims").find((r) => r.id === claimId)).toEqual(claimBefore); // historical claim untouched
    expect(db.rows("project_stages").filter((r) => r.project_id === parent)).toEqual(stagesBefore);
    const baseAfter = (await loadProjectView(db as never, ORG, parent))!;
    expect(baseAfter.claims.map((c) => c.id)).toEqual([claimId]); // the variation claim is not a base claim
    const c = (await loadConsolidatedProject(db as never, ORG, parent))!;
    expect(c.totals.committedCents).toBe(R(1_000_000) + R(480_000)); // base deposit + the variation's single 100% stage, each once
  });
  it("the original contract value never moves", async () => {
    const { db, parent, mk } = await world();
    await createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: await mk(R(480_000)) });
    expect(db.rows("projects").find((p) => p.id === parent)?.original_contract_cents).toBe(R(10_000_000));
  });
});

describe("isolation", () => {
  it("another organisation can neither read the consolidation nor start billing for the project, and its rows are never mixed in", async () => {
    const { db, parent, mk } = await world();
    const v = await mk(R(480_000));
    expect(await loadConsolidatedProject(db as never, "org-b", parent)).toBeNull();
    expect(await err(createVariationBillingProject(db as never, MGR, "m@x", { orgId: "org-b", projectId: parent, variationId: v }))).toBeDefined();
    // a foreign billing project row that points at this parent must not appear in the consolidation
    db.rows("projects").push({ id: "alien", org_id: "org-b", parent_project_id: parent, billing_scope: "VARIATION", variation_id: "x", project_reference: "ALIEN", status: "ACTIVE", original_contract_cents: 1 });
    const c = (await loadConsolidatedProject(db as never, ORG, parent))!;
    expect(c.scopes).toHaveLength(1);
  });
  it("only a manager starts variation billing; a DRAFT or unscheduled variation is never billable", async () => {
    const { db, parent, mk } = await world();
    const v = await mk(R(480_000));
    expect(await err(createVariationBillingProject(db as never, { isManager: false }, "x", { orgId: ORG, projectId: parent, variationId: v }))).toMatch(/manager/);
    const draft = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "d", description: "", amountCents: 100 });
    expect(await err(createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: draft.variationId }))).toMatch(/APPROVED/);
  });
});

describe("audit trail / lineage", () => {
  it("the billing project records the variation, parent and schedule it was created from", async () => {
    const { db, parent, mk } = await world();
    const v = await mk(R(480_000), [{ name: "Order", bps: 3000 }, { name: "Delivery", bps: 7000 }]);
    const { billingProjectId } = await createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: v });
    const row = db.rows("projects").find((p) => p.id === billingProjectId)!;
    expect(row).toMatchObject({ billing_scope: "VARIATION", parent_project_id: parent, variation_id: v, created_by_email: "m@x" });
    expect((row.baseline_snapshot as { schedule: unknown[] }).schedule).toHaveLength(2);
  });
});
