import { describe, it, expect } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { ProjectInvariantError } from "../claim-engine";
import {
  approveClaim, cancelDraftClaim, createClaimDraft, loadProjectView, previewClaim, recordProgress,
  seedGoldenFixture, submitClaimForApproval,
} from "../project-store";

const ORG_A = "org-a";
const ORG_B = "org-b";
const R = (n: number) => n * 100;

async function seeded() {
  const db = new FakeDb();
  const projectId = await seedGoldenFixture(db as never, ORG_A, "mgr@a", goldenFixtureBaseline());
  return { db, projectId };
}
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof ProjectInvariantError ? e.code : (e as Error).message; }
  return undefined;
};

describe("golden scenario through the real store", () => {
  it("seeds a balanced R10m project with an approved opening claim that reserves value", async () => {
    const { db, projectId } = await seeded();
    const v = (await loadProjectView(db as never, ORG_A, projectId))!;
    expect(v.project.status).toBe("ACTIVE");
    expect(v.commercial.scheduleBalanced).toBe(true);
    expect(v.stages.map((s) => s.valueCents)).toEqual([R(1_000_000), R(3_000_000), R(2_000_000), R(2_000_000), R(1_500_000), R(500_000)]);
    expect(v.claims).toHaveLength(1);
    expect(v.claims[0].status).toBe("APPROVED");
    expect(v.commercial.committedCents).toBe(R(2_500_000));
  });

  it("shows physical, approved and committed separately (Manufacturing 75 / 65 / 50)", async () => {
    const { db, projectId } = await seeded();
    const v = (await loadProjectView(db as never, ORG_A, projectId))!;
    const mfg = v.stages.find((s) => s.name === "Manufacturing")!;
    expect([mfg.reportedBps, mfg.approvedBps, mfg.committedBps]).toEqual([7500, 6500, 5000]);
    expect(mfg.earnedCents).toBe(R(1_950_000));
    expect(mfg.claimableCents).toBe(R(450_000));
    expect(mfg.history).toHaveLength(2); // history retained, not overwritten
  });

  it("GOLDEN CLAIM: Manufacturing R450,000 + Delivery R500,000 = R950,000; VAT R142,500; total R1,092,500", async () => {
    const { db, projectId } = await seeded();
    const p = await previewClaim(db as never, ORG_A, projectId);
    expect(p.calc.lines.map((l) => [l.stageName, l.currentClaimCents])).toEqual([["Manufacturing", R(450_000)], ["Delivery", R(500_000)]]);
    expect(p.calc.subtotalCents).toBe(R(950_000));
    expect(p.calc.taxCents).toBe(R(142_500));
    expect(p.calc.totalCents).toBe(R(1_092_500));
    expect(p.claimNumber.endsWith("-C02")).toBe(true);
  });

  it("preview/calculation performs NO writes", async () => {
    const { db, projectId } = await seeded();
    const before = db.writes.length;
    await previewClaim(db as never, ORG_A, projectId);
    expect(db.writes.length).toBe(before);
  });

  it("SECOND CLAIM: approving claim #2 subtracts it — the same state yields nothing to claim", async () => {
    const { db, projectId } = await seeded();
    const d = await createClaimDraft(db as never, ORG_A, "pm@a", projectId);
    await submitClaimForApproval(db as never, ORG_A, projectId, d.claimId);
    await approveClaim(db as never, ORG_A, "mgr@a", projectId, d.claimId);
    expect(await code(previewClaim(db as never, ORG_A, projectId))).toBe("NOTHING_TO_CLAIM");
    const v = (await loadProjectView(db as never, ORG_A, projectId))!;
    expect(v.commercial.committedCents).toBe(R(2_500_000 + 950_000));
    // progress advances -> only the increment is claimable
    const mfg = v.stages.find((s) => s.name === "Manufacturing")!;
    await recordProgress(db as never, ORG_A, "mgr@a", { projectId, stageId: mfg.id, reportedPct: "100", approvedPct: "100", comment: "complete" });
    const p = await previewClaim(db as never, ORG_A, projectId);
    expect(p.calc.lines.map((l) => [l.stageName, l.currentClaimCents])).toEqual([["Manufacturing", R(1_050_000)]]);
  });
});

describe("idempotency", () => {
  it("submitting the same preview twice returns the SAME draft (no duplicate claim)", async () => {
    const { db, projectId } = await seeded();
    const a = await createClaimDraft(db as never, ORG_A, "pm@a", projectId);
    const b = await createClaimDraft(db as never, ORG_A, "pm@a", projectId);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.claimId).toBe(a.claimId);
    expect(db.rows("project_claims").filter((c) => c.status === "DRAFT")).toHaveLength(1);
  });
  it("a draft does not reserve value: claimable is unchanged after drafting", async () => {
    const { db, projectId } = await seeded();
    const before = (await loadProjectView(db as never, ORG_A, projectId))!.commercial.claimableCents;
    await createClaimDraft(db as never, ORG_A, "pm@a", projectId);
    expect((await loadProjectView(db as never, ORG_A, projectId))!.commercial.claimableCents).toBe(before);
  });
  it("a stale draft cannot be approved after another claim reserved the same value", async () => {
    const { db, projectId } = await seeded();
    const first = await createClaimDraft(db as never, ORG_A, "pm@a", projectId);
    await submitClaimForApproval(db as never, ORG_A, projectId, first.claimId);
    // force a SECOND draft of the same value by cancelling nothing and inserting directly (simulates a race)
    const second = { ...db.rows("project_claims").find((c) => c.id === first.claimId)!, id: "race-2", claim_seq: 99, claim_number: "X-C99", idempotency_key: "race", status: "READY_FOR_APPROVAL" };
    db.rows("project_claims").push(second);
    for (const l of db.rows("project_claim_lines").filter((l) => l.claim_id === first.claimId)) db.rows("project_claim_lines").push({ ...l, id: `l-${l.id}`, claim_id: "race-2" });
    await approveClaim(db as never, ORG_A, "mgr@a", projectId, first.claimId);
    expect(await code(approveClaim(db as never, ORG_A, "mgr@a", projectId, "race-2"))).toBeDefined(); // stale/over-claim refused
  });
});

describe("approved claims are frozen snapshots", () => {
  it("later progress changes never alter an approved claim's stored lines", async () => {
    const { db, projectId } = await seeded();
    const d = await createClaimDraft(db as never, ORG_A, "pm@a", projectId);
    await submitClaimForApproval(db as never, ORG_A, projectId, d.claimId);
    await approveClaim(db as never, ORG_A, "mgr@a", projectId, d.claimId);
    const snapshot = JSON.stringify(db.rows("project_claim_lines").filter((l) => l.claim_id === d.claimId));
    const v = (await loadProjectView(db as never, ORG_A, projectId))!;
    await recordProgress(db as never, ORG_A, "mgr@a", { projectId, stageId: v.stages[1].id, reportedPct: "100", approvedPct: "100", comment: "later" });
    expect(JSON.stringify(db.rows("project_claim_lines").filter((l) => l.claim_id === d.claimId))).toBe(snapshot);
  });
});

describe("baseline immutability", () => {
  it("claiming fails closed if the contract value was mutated after a claim was approved", async () => {
    const { db, projectId } = await seeded();
    db.rows("projects").find((p) => p.id === projectId)!.original_contract_cents = R(10_000_001);
    expect(await code(previewClaim(db as never, ORG_A, projectId))).toBe("BASELINE_MUTATED");
  });
  it("…or if a stage value was rewritten", async () => {
    const { db, projectId } = await seeded();
    (db.rows("project_stages")[1].value_cents as number) += 100;
    const c = await code(previewClaim(db as never, ORG_A, projectId));
    expect(["BASELINE_MUTATED", "SCHEDULE_NOT_BALANCED"]).toContain(c);
  });
});

describe("organisation isolation", () => {
  it("another org cannot load, preview, draft, approve or record progress on the project", async () => {
    const { db, projectId } = await seeded();
    expect(await loadProjectView(db as never, ORG_B, projectId)).toBeNull();
    expect(await code(previewClaim(db as never, ORG_B, projectId))).toBe("Project not found.");
    expect(await code(createClaimDraft(db as never, ORG_B, "x@b", projectId))).toBe("Project not found.");
    const claimId = db.rows("project_claims")[0].id as string;
    expect(await code(approveClaim(db as never, ORG_B, "x@b", projectId, claimId))).toBe("Claim not found.");
    const stageId = db.rows("project_stages")[0].id as string;
    expect(await code(recordProgress(db as never, ORG_B, "x@b", { projectId, stageId, reportedPct: "10", approvedPct: null, comment: "" }))).toBe("Stage not found.");
    expect(await code(cancelDraftClaim(db as never, ORG_B, projectId, claimId))).toBeDefined();
  });
});

describe("progress rules", () => {
  it("rejects <0 and >100 and requires a reason when approval changes", async () => {
    const { db, projectId } = await seeded();
    const stageId = db.rows("project_stages")[3].id as string;
    expect(await code(recordProgress(db as never, ORG_A, "a", { projectId, stageId, reportedPct: "100.01", approvedPct: null, comment: "" }))).toBe("COMPLETION_OUT_OF_RANGE");
    expect(await code(recordProgress(db as never, ORG_A, "a", { projectId, stageId, reportedPct: "-1", approvedPct: null, comment: "" }))).toBe("COMPLETION_OUT_OF_RANGE");
    expect(await code(recordProgress(db as never, ORG_A, "a", { projectId, stageId, reportedPct: "25", approvedPct: "30", comment: " " }))).toMatch(/comment/i);
  });
  it("tax comes from the project's resolved rate, not a constant", async () => {
    const baseline = { ...goldenFixtureBaseline(), taxRateBps: 1000 };
    const db = new FakeDb();
    const projectId = await seedGoldenFixture(db as never, ORG_A, "mgr@a", baseline);
    const p = await previewClaim(db as never, ORG_A, projectId);
    expect(p.calc.taxCents).toBe(R(95_000)); // 10% of R950,000, not 15%
    expect(p.calc.totalCents).toBe(R(1_045_000));
  });
  it("changing the tax rate after a claim is approved is detected as baseline mutation", async () => {
    const { db, projectId } = await seeded();
    db.rows("projects").find((p) => p.id === projectId)!.tax_rate_bps = 0;
    expect(await code(previewClaim(db as never, ORG_A, projectId))).toBe("BASELINE_MUTATED");
  });
});
