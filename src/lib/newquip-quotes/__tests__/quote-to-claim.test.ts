import { describe, expect, it } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { createQuote, createProjectFromAcceptedQuote, estimatorSignOff, loadQuote, managerApprove, returnToRep, saveDraft, sendToEstimator } from "../quote-store";
import { approveClaim, createClaimDraft, loadProjectView, previewClaim, recordProgress, submitClaimForApproval } from "@/lib/projects/project-store";
import { approveVariation, raiseVariation, rejectVariation, repriceVariation } from "@/lib/projects/variation-store";
import { allocateClaim } from "@/lib/projects/variations";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { baselineMatchesHash } from "@/newquip/quote/baseline";
import { rolesFor } from "@/newquip/quote/roles";
import type { QuoteDraft } from "@/newquip/grower/draft";

// GATE 1 + GATE 2, end to end through the REAL stores (in-memory database stand-in, no manual DB manipulation):
//   Grower House Template v1 → configuration → estimator review → final quote → manager approval → frozen baseline → Project
//   → physical progress → manager commercial approval → R950,000 claim → Variation V001 → R10.48m revised contract.

const ORG = "org-newquip";
const rep = rolesFor("member"); // rep + estimator
const mgr = rolesFor("admin"); // + manager
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const R = (n: number) => n * 100;

/** A READY quote whose ex-VAT total is EXACTLY R10,000,000 (delivery is the plug), so the six-stage split is the golden schedule. */
function tenMillionDraft(): QuoteDraft {
  const d = readyDraft();
  const sub = (delivery: number) => evaluateDraft({ ...d, estimator: { ...d.estimator, charges: { ...d.estimator.charges, delivery } } }, ctx).budget!.totals.subtotalExTax;
  const plug = Math.round((10_000_000 - (sub(1) - 1)) * 100) / 100;
  return { ...d, estimator: { ...d.estimator, charges: { ...d.estimator.charges, delivery: plug } } };
}

async function acceptedQuote(db: FakeDb) {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, rep, id, tenMillionDraft());
  await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: R(10_000_000), confirmedBy: "Farmer Joe" });
  await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
  const approved = await managerApprove(db as never, ORG, mgr, "manager@nq", id, ctx);
  return { id, approved };
}
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

describe("GATE 1 — quote workflow to a frozen baseline and a Project", () => {
  it("the fixture quote is READY and totals exactly R10,000,000 ex VAT", () => {
    const ev = evaluateDraft(tenMillionDraft(), ctx);
    expect(ev.readiness.state).toBe("READY");
    expect(Math.round(ev.budget!.totals.subtotalExTax * 100)).toBe(R(10_000_000));
  });

  it("REP_DRAFT → ESTIMATOR_REVIEW → MANAGER_APPROVED_FINAL, recording each person and the customer's confirmation", async () => {
    const db = new FakeDb();
    const { id, approved } = await acceptedQuote(db);
    const q = (await loadQuote(db as never, ORG, id))!;
    expect(q.state).toBe("MANAGER_APPROVED_FINAL");
    expect(q).toMatchObject({ handoff_by_email: "rep@nq", customer_confirmed_by: "Farmer Joe", customer_confirmed_cents: R(10_000_000), estimator_signoff_by_email: "est@nq", approved_by_email: "manager@nq", contract_cents: R(10_000_000), revision: 1 });
    expect(q.baseline_hash).toBe(approved.baselineHash);
    expect(q.estimator_signoff_hash).toBe(q.draft_hash);
  });

  it("a rep cannot approve; approval needs the customer's confirmation, the estimator's sign-off of THIS content, and an unchanged total", async () => {
    const db = new FakeDb();
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    await saveDraft(db as never, ORG, rep, id, tenMillionDraft());
    // wrong amount
    expect(await err(sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: R(9_000_000), confirmedBy: "Joe" }))).toMatch(/must equal the quote total/);
    // no customer name
    expect(await err(sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: R(10_000_000), confirmedBy: " " }))).toMatch(/who at the customer/);
    // not in review yet
    expect(await err(managerApprove(db as never, ORG, mgr, "m@nq", id, ctx))).toMatch(/not possible from Rep draft/);
    await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: R(10_000_000), confirmedBy: "Joe" });
    // no sign-off yet; and a plain member lacks the manager role
    expect(await err(managerApprove(db as never, ORG, rep, "rep@nq", id, ctx))).toMatch(/Requires the manager role/);
    expect(await err(managerApprove(db as never, ORG, mgr, "m@nq", id, ctx))).toMatch(/has not signed off/);
    await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
    // an edit after sign-off CLEARS the sign-off
    const edited = tenMillionDraft();
    edited.estimator.assumptions = "changed after sign-off";
    const saved = await saveDraft(db as never, ORG, rep, id, edited);
    expect(saved.signoffCleared).toBe(true);
    expect(await err(managerApprove(db as never, ORG, mgr, "m@nq", id, ctx))).toMatch(/has not signed off/);
    await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
    // a content change that moves the total makes the customer's confirmation stale
    const moved = tenMillionDraft();
    moved.estimator.charges = { ...moved.estimator.charges, installation: 500_000 };
    await saveDraft(db as never, ORG, rep, id, moved);
    await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
    expect(await err(managerApprove(db as never, ORG, mgr, "m@nq", id, ctx))).toMatch(/total changed since the customer confirmed/);
    // return to the rep → new revision, confirmation cleared
    await returnToRep(db as never, ORG, mgr, id, "Re-confirm with the customer");
    const q = (await loadQuote(db as never, ORG, id))!;
    expect(q).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null, estimator_signoff_hash: null });
  });

  it("an incomplete quote cannot be handed off, signed off or approved (BLOCKED)", async () => {
    const db = new FakeDb();
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    const d = tenMillionDraft();
    d.estimator.unitPrices = {}; // M75 commercial price missing
    await saveDraft(db as never, ORG, rep, id, d);
    expect(await err(sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: R(10_000_000), confirmedBy: "Joe" }))).toMatch(/BLOCKED/);
  });

  it("manager approval FREEZES the accepted baseline: the quote is no longer editable and later price/rule changes cannot mutate it", async () => {
    const db = new FakeDb();
    const { id } = await acceptedQuote(db);
    const q = (await loadQuote(db as never, ORG, id))!;
    const before = JSON.stringify(q.accepted_baseline);
    const b = q.accepted_baseline!;
    // contents
    expect(b.template).toMatchObject({ id: "grower-house-v1", name: "Grower House Template v1", version: "1.0" });
    expect(b.configuration.rooms).toBe(12);
    expect(b.pricing.source.label).toBe("NewQuip Master workbook – POC controlled snapshot");
    expect(b.rules.length).toBeGreaterThan(10);
    expect(b.estimator.confirmedMappings.feeder).toBe("PNQ082");
    expect(b.selectedProducts.find((p) => p.itemKey === "feeder")).toMatchObject({ sku: "PNQ082", variant: "STANDARD" });
    expect(b.priceResolutions.map((r) => r.itemKey)).toEqual(["led_light"]);
    expect(b.commercial.totalCents).toBe(b.commercial.subtotalCents + b.commercial.taxCents);
    expect(b.contractCents).toBe(R(10_000_000));
    expect(b.approvals.managerApprovedBy).toBe("manager@nq");
    // Cost/margin figures live ONLY in the sealed `internalMargin` section (never in the commercial baseline a Project is built from).
    expect(JSON.stringify({ ...b, internalMargin: undefined })).not.toMatch(/"(averageCost|landedCost|estimatedCost|estimatedGP|marginPct)/i); // cost never enters the baseline
    expect(Object.isFrozen(b)).toBe(true); // deep-frozen when built …
    expect(baselineMatchesHash(q.accepted_baseline, q.baseline_hash!)).toBe(true); // … and its seal verifies
    // editing / re-approving / reopening an accepted quote is refused
    expect(await err(saveDraft(db as never, ORG, rep, id, tenMillionDraft()))).toMatch(/final and cannot be edited.*Variations/);
    expect(await err(managerApprove(db as never, ORG, mgr, "m@nq", id, ctx))).toMatch(/final and cannot be changed/);
    expect(await err(returnToRep(db as never, ORG, mgr, id, "x"))).toMatch(/final and cannot be changed/);
    // a price change after acceptance does not alter the stored snapshot
    const dearer = { priceSource: { ...testPriceSource(), priceFor: () => ({ status: "priced" as const, unitPriceExVat: 999_999, landedCostExVat: 1 }) }, withholdCost: true };
    expect(evaluateDraft(q.draft, dearer).budget!.totals.subtotalExTax).not.toBe(10_000_000);
    expect(JSON.stringify((await loadQuote(db as never, ORG, id))!.accepted_baseline)).toBe(before);
  });

  it("a tampered baseline is refused before any Project is created", async () => {
    const db = new FakeDb();
    const { id } = await acceptedQuote(db);
    db.rows("newquip_quotes")[0].accepted_baseline = { ...structuredClone(db.rows("newquip_quotes")[0].accepted_baseline as object), contractCents: 1 };
    expect(await err(createProjectFromAcceptedQuote(db as never, ORG, "m@nq", id))).toMatch(/no longer matches its seal/);
    expect(db.rows("projects")).toHaveLength(0);
  });

  it("only an approved quote can become a Project", async () => {
    const db = new FakeDb();
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    expect(await err(createProjectFromAcceptedQuote(db as never, ORG, "m@nq", id))).toMatch(/manager-approved final quote/);
  });

  it("a quote of another organisation is invisible", async () => {
    const db = new FakeDb();
    const { id } = await acceptedQuote(db);
    expect(await loadQuote(db as never, "org-other", id)).toBeNull();
    expect(await err(managerApprove(db as never, "org-other", mgr, "m@x", id, ctx))).toMatch(/Quote not found/);
  });
});

describe("GATE 1 → 2 — Quote → Project, with no engineering recalculation", () => {
  it("creates an ACTIVE, balanced Project carrying customer, site, quote ref, contract value, tax basis, stages, scope and provenance", async () => {
    const db = new FakeDb();
    const { id } = await acceptedQuote(db);
    const q = (await loadQuote(db as never, ORG, id))!;
    const { projectId, created } = await createProjectFromAcceptedQuote(db as never, ORG, "m@nq", id);
    expect(created).toBe(true);
    const v = (await loadProjectView(db as never, ORG, projectId))!;
    expect(v.project).toMatchObject({ status: "ACTIVE", customer_name: "Topigs Warden", originating_quote_ref: q.quote_ref, original_contract_cents: R(10_000_000), tax_rate_bps: 1500, tax_rule: "VAT 15% (NewQuip POC)" });
    expect(v.project.name).toContain("Warden Grower House");
    expect(v.stages.map((s) => s.name)).toEqual(["Deposit", "Manufacturing", "Equipment Ready", "Delivery", "Installation", "Commissioning"]);
    expect(v.stages.map((s) => s.valueCents)).toEqual([R(1_000_000), R(3_000_000), R(2_000_000), R(2_000_000), R(1_500_000), R(500_000)]);
    expect(v.commercial.scheduleBalanced).toBe(true);
    expect(v.allocations.length).toBeGreaterThan(5); // accepted scope/components
    const snap = (db.rows("projects")[0].baseline_snapshot) as { provenance: Record<string, unknown> };
    expect(snap.provenance).toMatchObject({ kind: "newquip_grower_quote", quoteRef: q.quote_ref, baselineHash: q.baseline_hash, template: { name: "Grower House Template v1" } });
    expect((await loadQuote(db as never, ORG, id))!.project_id).toBe(projectId);
  });

  it("is idempotent, and recovers a project that was created but not linked", async () => {
    const db = new FakeDb();
    const { id } = await acceptedQuote(db);
    const a = await createProjectFromAcceptedQuote(db as never, ORG, "m@nq", id);
    const b = await createProjectFromAcceptedQuote(db as never, ORG, "m@nq", id);
    expect(b).toEqual({ projectId: a.projectId, created: false });
    expect(db.rows("projects")).toHaveLength(1);
    db.rows("newquip_quotes")[0].project_id = null; // simulate a crash between create and link
    const c = await createProjectFromAcceptedQuote(db as never, ORG, "m@nq", id);
    expect(c.projectId).toBe(a.projectId);
    expect(db.rows("projects")).toHaveLength(1);
  });
});

describe("GATE 2 — progress, the R950,000 golden claim, Variation V001, revised contract", () => {
  async function projectAtGoldenPosition() {
    const db = new FakeDb();
    const { id } = await acceptedQuote(db);
    const { projectId } = await createProjectFromAcceptedQuote(db as never, ORG, "m@nq", id);
    const view = (await loadProjectView(db as never, ORG, projectId))!;
    const stage = (n: string) => view.stages.find((s) => s.name === n)!.id;
    const rec = (n: string, reported: string, approved: string | null, c: string) => recordProgress(db as never, ORG, "x@nq", { projectId, stageId: stage(n), reportedPct: reported, approvedPct: approved, comment: c });
    await rec("Deposit", "100", "100", "deposit invoiced");
    await rec("Manufacturing", "50", "50", "opening position");
    const opening = await createClaimDraft(db as never, ORG, "x@nq", projectId);
    await submitClaimForApproval(db as never, ORG, projectId, opening.claimId);
    await approveClaim(db as never, ORG, "manager@nq", projectId, opening.claimId);
    await rec("Manufacturing", "75", "65", "physical 75; manager approved 65 commercially");
    await rec("Delivery", "25", "25", "first trucks delivered");
    return { db, projectId };
  }

  it("physical ≠ commercial ≠ committed; the next claim is Manufacturing R450,000 + Delivery R500,000 = R950,000 (VAT R142,500, total R1,092,500)", async () => {
    const { db, projectId } = await projectAtGoldenPosition();
    const v = (await loadProjectView(db as never, ORG, projectId))!;
    const mfg = v.stages.find((s) => s.name === "Manufacturing")!;
    expect([mfg.reportedBps, mfg.approvedBps, mfg.committedBps]).toEqual([7500, 6500, 5000]);
    expect(v.stages.find((s) => s.name === "Deposit")!.committedCents).toBe(R(1_000_000));
    expect(mfg.committedCents).toBe(R(1_500_000));
    const p = await previewClaim(db as never, ORG, projectId);
    expect(p.calc.lines.map((l) => [l.stageName, l.currentClaimCents])).toEqual([["Manufacturing", R(450_000)], ["Delivery", R(500_000)]]);
    expect(p.calc.subtotalCents).toBe(R(950_000));
    expect(p.calc.taxCents).toBe(R(142_500));
    expect(p.calc.totalCents).toBe(R(1_092_500));
  });

  it("V001 Additional Ventilation R480,000: original stays R10,000,000; only the revised contract moves to R10,480,000", async () => {
    const { db, projectId } = await projectAtGoldenPosition();
    const { variationId, code } = await raiseVariation(db as never, ORG, "est@nq", { projectId, title: "Additional Ventilation", description: "AS.03 fans", amountCents: R(480_000) });
    expect(code).toBe("V001");
    // DRAFT does not affect any contract value
    let c = (await loadProjectView(db as never, ORG, projectId))!.commercial;
    expect([c.originalContractCents, c.approvedVariationsCents, c.revisedContractCents]).toEqual([R(10_000_000), 0, R(10_000_000)]);
    await approveVariation(db as never, ORG, "manager@nq", projectId, variationId);
    const v = (await loadProjectView(db as never, ORG, projectId))!;
    c = v.commercial;
    expect([c.originalContractCents, c.approvedVariationsCents, c.revisedContractCents]).toEqual([R(10_000_000), R(480_000), R(10_480_000)]);
    expect(v.project.original_contract_cents).toBe(R(10_000_000)); // the stored original NEVER changed
    expect(db.rows("projects")[0].original_contract_cents).toBe(R(10_000_000));
    // the existing claim mathematics is untouched
    expect((await previewClaim(db as never, ORG, projectId)).calc.subtotalCents).toBe(R(950_000));
  });

  it("rejected and draft variations never affect the contract; decisions are final; amounts are positive", async () => {
    const { db, projectId } = await projectAtGoldenPosition();
    const a = await raiseVariation(db as never, ORG, "est@nq", { projectId, title: "Extra", description: "", amountCents: R(100_000) });
    const b = await raiseVariation(db as never, ORG, "est@nq", { projectId, title: "More", description: "", amountCents: R(50_000) });
    expect(b.code).toBe("V002");
    expect(await err(rejectVariation(db as never, ORG, "manager@nq", projectId, a.variationId, "  "))).toMatch(/reason is required/);
    await rejectVariation(db as never, ORG, "manager@nq", projectId, a.variationId, "Out of scope");
    expect((await loadProjectView(db as never, ORG, projectId))!.commercial.revisedContractCents).toBe(R(10_000_000));
    expect(await err(approveVariation(db as never, ORG, "manager@nq", projectId, a.variationId))).toMatch(/cannot become APPROVED/);
    expect(await err(repriceVariation(db as never, ORG, "est@nq", projectId, a.variationId, R(1)))).toMatch(/Only a DRAFT/);
    await repriceVariation(db as never, ORG, "est@nq", projectId, b.variationId, R(60_000));
    await approveVariation(db as never, ORG, "manager@nq", projectId, b.variationId);
    expect(await err(approveVariation(db as never, ORG, "manager@nq", projectId, b.variationId))).toMatch(/cannot become APPROVED/);
    expect((await loadProjectView(db as never, ORG, projectId))!.commercial).toMatchObject({ approvedVariationsCents: R(60_000), revisedContractCents: R(10_060_000) });
    expect(await err(raiseVariation(db as never, ORG, "est@nq", { projectId, title: "Zero", description: "", amountCents: 0 }))).toMatch(/positive whole number/);
  });

  it("Cin7 is represented, never written: SO-POC-001 / SO-POC-002, both NOT SENT TO CIN7, under the same Project", async () => {
    const { db, projectId } = await projectAtGoldenPosition();
    const { variationId } = await raiseVariation(db as never, ORG, "est@nq", { projectId, title: "Additional Ventilation", description: "", amountCents: R(480_000) });
    await approveVariation(db as never, ORG, "manager@nq", projectId, variationId);
    const v = (await loadProjectView(db as never, ORG, projectId))!;
    expect(v.cin7Representation.map((r) => [r.saleRef, r.state, r.valueCents])).toEqual([["SO-POC-001", "NOT SENT TO CIN7", R(10_000_000)], ["SO-POC-002", "NOT SENT TO CIN7", R(480_000)]]);
    expect(db.rows("project_cin7_links")).toHaveLength(0);
  });

  it("one Project claim may span original + variation value: C005 R550,000 = R450,000 + R100,000", () => {
    const ok = allocateClaim(R(550_000), [{ label: "Original", amountCents: R(450_000), remainingCents: R(8_500_000) }, { label: "V001", amountCents: R(100_000), remainingCents: R(480_000) }]);
    expect(ok.ok).toBe(true);
    expect(allocateClaim(R(550_000), [{ label: "Original", amountCents: R(450_000), remainingCents: R(8_500_000) }, { label: "V001", amountCents: R(90_000), remainingCents: R(480_000) }]).ok).toBe(false);
    expect(allocateClaim(R(550_000), [{ label: "Original", amountCents: R(450_000), remainingCents: R(8_500_000) }, { label: "V001", amountCents: R(100_000), remainingCents: R(50_000) }]).ok).toBe(false);
  });

  it("NO Cin7 write occurred anywhere in the whole flow: only local NewQuip / Projects tables were written", async () => {
    const { db, projectId } = await projectAtGoldenPosition();
    const { variationId } = await raiseVariation(db as never, ORG, "est@nq", { projectId, title: "Additional Ventilation", description: "", amountCents: R(480_000) });
    await approveVariation(db as never, ORG, "manager@nq", projectId, variationId);
    const tables = new Set(db.writes.map((w) => w.table));
    expect([...tables].sort()).toEqual(["newquip_quotes", "project_claim_lines", "project_claims", "project_progress_events", "project_stage_allocations", "project_stages", "project_variation_stages", "project_variations", "projects"]);
    expect(db.rows("project_cin7_links")).toHaveLength(0);
  });
});
