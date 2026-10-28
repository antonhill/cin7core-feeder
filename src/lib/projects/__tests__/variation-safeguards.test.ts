// Regression tests for the variation safeguards (migration 0106 mirrored in the application).
import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, recordProgress, setOpeningCommitments, submitClaimForApproval } from "../project-store";
import { approveVariation, raiseVariation, repriceVariation, validateAmount } from "../variation-store";
import { closureBlockers, createVariationBillingProject, unresolvedItems } from "../variation-billing-store";
import { NEGATIVE_VARIATION_UNSUPPORTED, isNegativeAmountInput } from "../variations";
import { buildCreationPlan } from "../cin7-sale-creation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORG = "org-a";
const MGR = { isManager: true };
const R = (n: number) => n * 100;
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

async function world() {
  const db = new FakeDb();
  const parent = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "n" });
  const v = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "V", description: "", amountCents: R(480_000) });
  await approveVariation(db as never, ORG, "m@x", parent, v.variationId);
  const { billingProjectId: scope } = await createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: v.variationId });
  return { db, parent, scope, variationId: v.variationId };
}

describe("parent closure is blocked by unresolved child scopes", () => {
  it("an open scope blocks the parent; a resolved, finished scope does not", async () => {
    const { db, parent, scope } = await world();
    expect((await closureBlockers(db as never, ORG, parent)).join(" | ")).toMatch(/variation scope PRJ-NQ-Q-0001-V001 is still ACTIVE/);
    db.rows("projects").find((p) => p.id === scope)!.status = "COMPLETED";
    expect(await closureBlockers(db as never, ORG, parent)).toEqual([]);
  });
  it("unfinished claims, approved claims without a Cin7 invoice, unreconciled / uncertain / mismatched postings and unfinished Sale creations all block", async () => {
    const { db, scope } = await world();
    const child = (await loadProjectView(db as never, ORG, scope))!;
    await recordProgress(db as never, ORG, "x@x", { projectId: scope, stageId: child.stages[0].id, reportedPct: "100", approvedPct: "100", comment: "c" });
    const { claimId } = await createClaimDraft(db as never, ORG, "x@x", scope);
    expect(await unresolvedItems(db as never, ORG, scope)).toEqual([expect.stringMatching(/claim .* is DRAFT/)]);
    await submitClaimForApproval(db as never, ORG, scope, claimId);
    expect((await unresolvedItems(db as never, ORG, scope))[0]).toMatch(/is READY_FOR_APPROVAL/);
    await approveClaim(db as never, ORG, "mgr@x", scope, claimId);
    expect((await unresolvedItems(db as never, ORG, scope))[0]).toMatch(/approved claim .* has no Cin7 invoice/);

    const posting = (state: string, extra: Record<string, unknown> = {}) => { db.tables["project_claim_cin7_postings"] = [{ id: "p", org_id: ORG, project_id: scope, claim_id: claimId, posting_state: state, memo: "M", cin7_invoice_number: "INV-1", ...extra }]; };
    posting("PENDING"); expect((await unresolvedItems(db as never, ORG, scope)).join("|")).toMatch(/posting INV-1 is PENDING/);
    posting("FAILED_UNCERTAIN"); expect((await unresolvedItems(db as never, ORG, scope)).join("|")).toMatch(/FAILED_UNCERTAIN/);
    posting("CREATED"); expect((await unresolvedItems(db as never, ORG, scope)).join("|")).toMatch(/is CREATED/);
    posting("RECONCILED", { last_error_code: "AMOUNT_MISMATCH" }); expect((await unresolvedItems(db as never, ORG, scope)).join("|")).toMatch(/amount mismatch/);
    posting("RECONCILED"); expect(await unresolvedItems(db as never, ORG, scope)).toEqual([]);

    db.tables["project_cin7_sale_creations"] = [{ id: "c", org_id: ORG, project_id: scope, creation_state: "FAILED_UNCERTAIN" }];
    expect(await unresolvedItems(db as never, ORG, scope)).toEqual(["Cin7 Sale creation is FAILED_UNCERTAIN"]);
  });
  it("a finished child cannot hide obligations from the parent's closure check", async () => {
    const { db, parent, scope } = await world();
    db.rows("projects").find((p) => p.id === scope)!.status = "CLOSED";
    db.tables["project_cin7_sale_creations"] = [{ id: "c", org_id: ORG, project_id: scope, creation_state: "PENDING" }];
    expect((await closureBlockers(db as never, ORG, parent)).join("|")).toMatch(/PRJ-NQ-Q-0001-V001: Cin7 Sale creation is PENDING/);
  });
  it("a variation scope reports its own unresolved items; an ordinary project with no scopes has no blockers", async () => {
    const { db, scope } = await world();
    db.tables["project_cin7_sale_creations"] = [{ id: "c", org_id: ORG, project_id: scope, creation_state: "CREATED" }];
    expect(await closureBlockers(db as never, ORG, scope)).toEqual(["Cin7 Sale creation is CREATED"]);
    const solo = await createProjectFromBaseline(db as never, ORG, "m@x", { ...goldenFixtureBaseline(), sourceQuoteRef: "SOLO" }, { reference: "SOLO", name: "s" });
    expect(await closureBlockers(db as never, ORG, solo)).toEqual([]);
  });
  it("the database rule exists in migration 0106 for all three terminal statuses", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "..", "supabase", "migrations", "0106_project_variation_safeguards.sql"), "utf8");
    expect(sql).toMatch(/array\['COMPLETED', 'CLOSED', 'CANCELLED'\]/);
    expect(sql).toMatch(/create trigger projects_closure_guard_trg before update of status on projects/);
  });
});

describe("no opening commitments on variation billing projects", () => {
  it("the store refuses, with an explicit reason, before touching anything", async () => {
    const { db, scope } = await world();
    const child = (await loadProjectView(db as never, ORG, scope))!;
    const writes = db.writes.length;
    expect(await err(setOpeningCommitments(db as never, ORG, "m@x", { projectId: scope, reason: "pre-billed", items: [{ stageId: child.stages[0].id, amountCents: 100 }] }))).toMatch(/cannot carry opening commitments/);
    expect(db.writes.length).toBe(writes);
    expect(db.rows("project_opening_commitments")).toHaveLength(0);
  });
  it("an ordinary project still accepts them", async () => {
    const { db, parent } = await world();
    const base = (await loadProjectView(db as never, ORG, parent))!;
    await setOpeningCommitments(db as never, ORG, "m@x", { projectId: parent, reason: "opening", items: [{ stageId: base.stages[0].id, amountCents: R(1_000_000) }] });
    expect(db.rows("project_opening_commitments")).toHaveLength(1);
  });
  it("the database rule exists in migration 0106", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "..", "supabase", "migrations", "0106_project_variation_safeguards.sql"), "utf8");
    expect(sql).toMatch(/project_opening_commitments_scope_guard_trg before insert or update on project_opening_commitments/);
  });
});

describe("negative variations are explicitly unsupported", () => {
  it("raising or re-pricing with a negative amount fails with the explicit message; nothing is stored", async () => {
    const { db, parent } = await world();
    const before = db.rows("project_variations").length;
    expect(await err(raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "Credit", description: "", amountCents: -R(10_000) }))).toBe(NEGATIVE_VARIATION_UNSUPPORTED);
    expect(db.rows("project_variations")).toHaveLength(before);
    const ok = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "Draft", description: "", amountCents: 100 });
    expect(await err(repriceVariation(db as never, ORG, "e@x", parent, ok.variationId, -1))).toBe(NEGATIVE_VARIATION_UNSUPPORTED);
    expect(() => validateAmount(-1)).toThrow(NEGATIVE_VARIATION_UNSUPPORTED);
    expect(() => validateAmount(0)).toThrow(/positive/);
  });
  it("negative text input is recognised (minus sign, accountancy brackets)", () => {
    for (const t of ["-5000", " -5", "(5000)"]) expect(isNegativeAmountInput(t)).toBe(true);
    for (const t of ["5000", "480000.50", ""]) expect(isNegativeAmountInput(t)).toBe(false);
  });
  it("a negative contract can never become a Sale plan, and no credit note or negative line is ever built", () => {
    const r = buildCreationPlan({ projectRef: "P", role: "VARIATION", customerName: "c", location: "l", taxRule: "t", taxRateBps: 1500, revenueAccount: "200", contractCents: -R(5000), stages: [{ name: "x", valueCents: -R(5000) }], physicalLines: [], saleOrderDate: "2026-10-28" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/negative contract value is not supported/) });
  });
  it("a negative variation cannot be billed even if one were somehow approved", async () => {
    const { db, parent } = await world();
    const v = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "ok", description: "", amountCents: 100 });
    await approveVariation(db as never, ORG, "m@x", parent, v.variationId);
    db.rows("project_variations").find((x) => x.id === v.variationId)!.amount_cents = -100; // simulate a corrupt row
    expect(await err(createVariationBillingProject(db as never, MGR, "m@x", { orgId: ORG, projectId: parent, variationId: v.variationId }))).toBe(NEGATIVE_VARIATION_UNSUPPORTED);
  });
  it("no code path generates credit notes or negative Sales", () => {
    for (const rel of ["src/cin7/sale-order-write.ts", "src/cin7/sale-invoice-write.ts"]) {
      const src = readFileSync(join(__dirname, "..", "..", "..", "..", rel), "utf8");
      expect(src).not.toMatch(/credit.?note|CreditNote|\/sale\/creditnote/i);
    }
  });
});

describe("V001 and historical records are not altered by the safeguards", () => {
  it("closureBlockers / unresolvedItems / access guards are read-only", async () => {
    const { db, parent, scope } = await world();
    const filled = () => JSON.stringify(Object.fromEntries(Object.entries(db.tables).filter(([, r]) => r.length > 0)));
    const snapshot = filled(); const writes = db.writes.length;
    await closureBlockers(db as never, ORG, parent); await closureBlockers(db as never, ORG, scope); await unresolvedItems(db as never, ORG, scope);
    expect(filled()).toBe(snapshot);
    expect(db.writes.length).toBe(writes);
  });
});
