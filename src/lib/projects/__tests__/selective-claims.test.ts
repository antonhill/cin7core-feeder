import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, previewClaim, recordProgress, submitClaimForApproval } from "../project-store";
import { assertSelectionHonoured, normaliseSelection, requireExplicitSelection, selectionError } from "../claim-selection";

const ORG = "org-a";
async function world() {
  const db = new FakeDb();
  const projectId = await createProjectFromBaseline(db as never, ORG, "a@a", goldenFixtureBaseline(), { reference: "P-SEL", name: "Selective" });
  const v0 = (await loadProjectView(db as never, ORG, projectId))!;
  const stage = (name: string) => v0.stages.find((s) => s.name === name)!;
  const rec = (name: string, pct: string) => recordProgress(db as never, ORG, "a@a", { projectId, stageId: stage(name).id, reportedPct: pct, approvedPct: pct, comment: "x" } as never);
  await rec("Deposit / Commencement", "100");
  await rec("Manufacturing", "50");
  const lines = (claimId: string) => db.rows("project_claim_lines").filter((l) => l.claim_id === claimId);
  return { db, projectId, stage, lines };
}

describe("UAT-013: selective claims (stage level)", () => {
  it("a Deposit-only claim contains ONLY the deposit line, with VAT on that line", async () => {
    const w = await world();
    const dep = w.stage("Deposit / Commencement");
    const d = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [dep.id]);
    const lines = w.lines(d.claimId);
    expect(lines).toHaveLength(1);
    expect(lines[0].stage_id).toBe(dep.id);
    const claim = w.db.rows("project_claims").find((c) => c.id === d.claimId)!;
    expect(claim.subtotal_cents).toBe(lines[0].current_claim_cents);
    expect(claim.total_cents).toBe((claim.subtotal_cents as number) + (claim.tax_cents as number));
    expect(claim.tax_cents).toBe(lines[0].tax_cents);
  });

  it("a Manufacturing-only claim leaves the deposit claimable for a later claim; the two together never exceed the combined claim", async () => {
    const w = await world();
    const dep = w.stage("Deposit / Commencement"); const man = w.stage("Manufacturing");
    const combined = await previewClaim(w.db as never, ORG, w.projectId, [dep.id, man.id]);
    const a = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [man.id]);
    await submitClaimForApproval(w.db as never, ORG, w.projectId, a.claimId);
    await approveClaim(w.db as never, ORG, "mgr@a", w.projectId, a.claimId);
    const next = await previewClaim(w.db as never, ORG, w.projectId, [dep.id]);
    expect(next.calc.lines.map((l) => l.stageId)).toEqual([dep.id]);
    expect(next.calc.subtotalCents + (w.lines(a.claimId)[0].current_claim_cents as number)).toBe(combined.calc.subtotalCents);
  });

  it("an approved stage cannot be claimed again (cumulative limit)", async () => {
    const w = await world();
    const dep = w.stage("Deposit / Commencement");
    const a = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [dep.id]);
    await submitClaimForApproval(w.db as never, ORG, w.projectId, a.claimId);
    await approveClaim(w.db as never, ORG, "mgr@a", w.projectId, a.claimId);
    await expect(createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [dep.id])).rejects.toThrow();
  });

  it("choosing a stage with nothing to claim fails instead of silently billing something else", async () => {
    const w = await world();
    await expect(createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.stage("Deposit / Commencement").id, w.stage("Delivery").id])).rejects.toThrow(/nothing new to claim/);
    expect(w.db.rows("project_claims").filter((c) => c.status === "DRAFT")).toHaveLength(0);
  });
});

describe("claim selection helpers", () => {
  const stages = [{ id: "a", name: "Deposit", claimableCents: 100 }, { id: "b", name: "Delivery", claimableCents: 0 }];
  it("requires an explicit, non-empty choice (never 'everything')", () => {
    expect(() => requireExplicitSelection(undefined)).toThrow(/at least one/);
    expect(() => requireExplicitSelection([])).toThrow();
    expect(requireExplicitSelection(["a", "a", ""])).toEqual(["a"]);
    expect(normaliseSelection(undefined)).toEqual([]);
  });
  it("explains why a selection is not allowed", () => {
    expect(selectionError(stages, [])).toMatch(/at least one/);
    expect(selectionError(stages, ["b"])).toMatch(/Delivery.*nothing to claim/);
    expect(selectionError(stages, ["zzz"])).toMatch(/does not belong/);
    expect(selectionError(stages, ["a"])).toBeNull();
  });
  it("detects a preview that silently dropped a chosen stage", () => {
    expect(() => assertSelectionHonoured(["a", "b"], [{ stageId: "a", stageName: "A" }])).toThrow();
    expect(() => assertSelectionHonoured(["a"], [{ stageId: "a", stageName: "A" }])).not.toThrow();
  });
});
