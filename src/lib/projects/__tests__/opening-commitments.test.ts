import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { createClaimDraft, createProjectFromBaseline, loadProjectView, previewClaim, recordProgress, setOpeningCommitments } from "../project-store";

const ORG = "org-a";
const R = (n: number) => n * 100;
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

/** A fresh Project (as created from an accepted quote): no claims, progress at the live-Gate-2 position. */
async function freshProject() {
  const db = new FakeDb();
  const id = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "n" });
  const v = (await loadProjectView(db as never, ORG, id))!;
  const st = (n: string) => v.stages.find((s) => s.name.startsWith(n))!.id;
  const rec = (n: string, rep: string, app: string) => recordProgress(db as never, ORG, "x@x", { projectId: id, stageId: st(n), reportedPct: rep, approvedPct: app, comment: "c" });
  await rec("Deposit", "100", "100");
  await rec("Manufacturing", "75", "65");
  await rec("Delivery", "25", "25");
  return { db, id, st };
}

describe("opening commitments — the live Gate 2 position", () => {
  it("WITHOUT them a fresh project shows the whole earned R3,450,000 as claimable (the live defect)", async () => {
    const { db, id } = await freshProject();
    const v = (await loadProjectView(db as never, ORG, id))!;
    expect([v.commercial.earnedCents, v.commercial.committedCents, v.commercial.claimableCents]).toEqual([R(3_450_000), 0, R(3_450_000)]);
  });

  it("Deposit R1m + Manufacturing R1.5m opening → Manufacturing R450k + Delivery R500k = R950k ex VAT, VAT R142,500, total R1,092,500", async () => {
    const { db, id, st } = await freshProject();
    await setOpeningCommitments(db as never, ORG, "mgr@x", { projectId: id, reason: "POC opening commercial commitments / prior certified amounts", items: [{ stageId: st("Deposit"), amountCents: R(1_000_000) }, { stageId: st("Manufacturing"), amountCents: R(1_500_000) }, { stageId: st("Equipment"), amountCents: 0 }] });
    const v = (await loadProjectView(db as never, ORG, id))!;
    const by = (n: string) => v.stages.find((s) => s.name.startsWith(n))!;
    expect([by("Deposit").committedCents, by("Manufacturing").committedCents, v.commercial.committedCents]).toEqual([R(1_000_000), R(1_500_000), R(2_500_000)]);
    expect([by("Deposit").claimableCents, by("Manufacturing").claimableCents, by("Delivery").claimableCents, v.commercial.claimableCents]).toEqual([0, R(450_000), R(500_000), R(950_000)]);
    expect(v.commercial.earnedCents).toBe(R(3_450_000));
    const p = await previewClaim(db as never, ORG, id);
    expect(p.calc.lines.map((l) => [l.stageName.split(" ")[0], l.currentClaimCents])).toEqual([["Manufacturing", R(450_000)], ["Delivery", R(500_000)]]);
    expect([p.calc.subtotalCents, p.calc.taxCents, p.calc.totalCents]).toEqual([R(950_000), R(142_500), R(1_092_500)]);
  });

  it("does not create claims, Cin7 links, or change progress, contract values or the baseline", async () => {
    const { db, id, st } = await freshProject();
    const before = await loadProjectView(db as never, ORG, id);
    const snap = JSON.stringify(db.rows("projects")[0].baseline_snapshot);
    const events = db.rows("project_progress_events").length;
    await setOpeningCommitments(db as never, ORG, "mgr@x", { projectId: id, reason: "r", items: [{ stageId: st("Deposit"), amountCents: R(1_000_000) }] });
    const after = (await loadProjectView(db as never, ORG, id))!;
    expect(after.claims).toHaveLength(0);
    expect(db.rows("project_claims")).toHaveLength(0);
    expect(db.rows("project_cin7_links")).toHaveLength(0);
    expect(db.rows("project_progress_events")).toHaveLength(events);
    expect(after.stages.map((s) => [s.reportedBps, s.approvedBps])).toEqual(before!.stages.map((s) => [s.reportedBps, s.approvedBps]));
    expect([after.commercial.originalContractCents, after.commercial.revisedContractCents]).toEqual([R(10_000_000), R(10_000_000)]);
    expect(JSON.stringify(db.rows("projects")[0].baseline_snapshot)).toBe(snap);
    expect([...new Set(db.writes.map((w) => w.table))].sort()).not.toContain("project_cin7_links");
  });

  it("can be edited while there are no claims, then FREEZES once any claim exists", async () => {
    const { db, id, st } = await freshProject();
    const set = (n: number) => setOpeningCommitments(db as never, ORG, "mgr@x", { projectId: id, reason: "r", items: [{ stageId: st("Deposit"), amountCents: R(n) }] });
    await set(500_000);
    await set(1_000_000); // edit
    expect((await loadProjectView(db as never, ORG, id))!.openingCommitments.map((o) => o.amount_cents)).toEqual([R(1_000_000)]);
    await db.from("projects").update({ status: "ACTIVE" }).eq("id", id);
    await createClaimDraft(db as never, ORG, "x@x", id);
    expect((await loadProjectView(db as never, ORG, id))!.openingCommitmentsLocked).toBe(true);
    expect(await err(set(2_000_000))).toMatch(/frozen/);
  });

  it("validates: reason required, non-negative whole cents, never above the stage value, stage must belong to the project", async () => {
    const { db, id, st } = await freshProject();
    const go = (items: Array<{ stageId: string; amountCents: number }>, reason = "r") => setOpeningCommitments(db as never, ORG, "mgr@x", { projectId: id, reason, items });
    expect(await err(go([{ stageId: st("Deposit"), amountCents: 1 }], "  "))).toMatch(/reason/i);
    expect(await err(go([{ stageId: st("Deposit"), amountCents: -1 }]))).toMatch(/zero or a positive/);
    expect(await err(go([{ stageId: st("Deposit"), amountCents: 1.5 }]))).toMatch(/whole number/);
    expect(await err(go([{ stageId: st("Deposit"), amountCents: R(1_000_001) }]))).toMatch(/cannot exceed the stage value/);
    expect(await err(go([{ stageId: "nope", amountCents: 1 }]))).toMatch(/Stage not found/);
    expect(await err(setOpeningCommitments(db as never, "org-other", "m@x", { projectId: id, reason: "r", items: [] }))).toMatch(/Project not found/);
  });
});
