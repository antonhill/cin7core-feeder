import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { computeProgressClaim, ProjectInvariantError } from "../claim-engine";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, previewClaim, recalculateStaleDraft, recordProgress, submitClaimForApproval } from "../project-store";
import { parsePartialAmounts } from "../claim-selection";

const ORG = "org-a";
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof ProjectInvariantError ? e.code : (e as Error).message; } return "NO_ERROR"; };

async function world() {
  const db = new FakeDb();
  const projectId = await createProjectFromBaseline(db as never, ORG, "a@a", goldenFixtureBaseline(), { reference: "P-PART", name: "Partial" });
  const v0 = (await loadProjectView(db as never, ORG, projectId))!;
  const stage = (name: string) => v0.stages.find((s) => s.name === name)!;
  const rec = (name: string, pct: string) => recordProgress(db as never, ORG, "a@a", { projectId, stageId: stage(name).id, reportedPct: pct, approvedPct: pct, comment: "x" } as never);
  await rec("Deposit / Commencement", "100");
  await rec("Manufacturing", "50");
  const dep = stage("Deposit / Commencement");
  const maxOf = async (id: string) => (await previewClaim(db as never, ORG, projectId, [id])).calc.lines[0].currentClaimCents;
  const lines = (claimId: string) => db.rows("project_claim_lines").filter((l) => l.claim_id === claimId);
  const claimRow = (claimId: string) => db.rows("project_claims").find((c) => c.id === claimId)!;
  const approve = async (claimId: string) => { await submitClaimForApproval(db as never, ORG, projectId, claimId); await approveClaim(db as never, ORG, "mgr@a", projectId, claimId); };
  return { db, projectId, stage, dep, rec, maxOf, lines, claimRow, approve };
}

describe("UAT-013 partial claim amounts (engine)", () => {
  const stages = [{ id: "s1", name: "Deposit", valueCents: 1_000_000 }, { id: "s2", name: "Rest", valueCents: 1_000_000 }];
  const base = { contractCents: 2_000_000, stages, progress: [{ stageId: "s1", approvedBps: 5000 }], priorClaims: [], taxRateBps: 1500, selectedStageIds: ["s1"] };
  it("a partial amount below the maximum is claimed exactly, flagged partial, with VAT on that amount", () => {
    const c = computeProgressClaim({ ...base, partialAmountsCents: { s1: 123_457 } });
    expect(c.lines[0]).toMatchObject({ currentClaimCents: 123_457, partial: true, earnedToDateCents: 500_000, remainingUnbilledCents: 1_000_000 - 123_457 });
    expect(c.lines[0].taxCents).toBe(Math.floor((123_457 * 1500 * 2 + 10_000) / 20_000)); // half-up, per line
    expect(c.totalCents).toBe(c.subtotalCents + c.taxCents);
  });
  it("the full maximum (explicit or implicit) is an ordinary non-partial claim", () => {
    expect(computeProgressClaim({ ...base }).lines[0]).toMatchObject({ currentClaimCents: 500_000, partial: false });
    expect(computeProgressClaim({ ...base, partialAmountsCents: { s1: 500_000 } }).lines[0]).toMatchObject({ currentClaimCents: 500_000, partial: false });
  });
  it("refuses an overclaim, zero, negative, fractional cents, an unselected stage and an unknown stage", () => {
    const run = (p: Record<string, number>) => { try { computeProgressClaim({ ...base, partialAmountsCents: p }); return "OK"; } catch (e) { return (e as ProjectInvariantError).code; } };
    expect(run({ s1: 500_001 })).toBe("PARTIAL_EXCEEDS_CLAIMABLE");
    expect(run({ s1: 0 })).toBe("INVALID_PARTIAL_AMOUNT");
    expect(run({ s1: -5 })).toBe("INVALID_PARTIAL_AMOUNT");
    expect(run({ s1: 10.5 })).toBe("INVALID_PARTIAL_AMOUNT");
    expect(run({ s2: 100 })).toBe("INVALID_PARTIAL_AMOUNT"); // s2 not selected
    expect(run({ nope: 100 })).toBe("UNKNOWN_STAGE");
  });
  it("earlier billing and reservations reduce the maximum a partial may reach", () => {
    const prior = [{ claimId: "c0", status: "APPROVED", lines: [{ stageId: "s1", currentClaimCents: 200_000 }] }] as never;
    const run = (n: number) => { try { return computeProgressClaim({ ...base, priorClaims: prior, partialAmountsCents: { s1: n } }).lines[0].currentClaimCents; } catch (e) { return (e as ProjectInvariantError).code; } };
    expect(run(300_000)).toBe(300_000); // 500k earned - 200k billed = 300k = the maximum, so full
    expect(run(300_001)).toBe("PARTIAL_EXCEEDS_CLAIMABLE");
  });
  it("clamp (recalculation only) caps instead of refusing", () => {
    const c = computeProgressClaim({ ...base, partialAmountsCents: { s1: 900_000 }, clampPartials: true });
    expect(c.lines[0]).toMatchObject({ currentClaimCents: 500_000, partial: false });
  });
});

describe("UAT-013 partial claim amounts (store)", () => {
  it("drafts a partial claim: the line, subtotal, VAT and total all reflect the entered amount, and the line is flagged partial", async () => {
    const w = await world();
    const max = await w.maxOf(w.dep.id);
    const amount = Math.floor(max / 3);
    const d = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: amount } });
    const [line] = w.lines(d.claimId);
    expect(line.current_claim_cents).toBe(amount);
    expect(line.partial).toBe(true);
    expect(line.earned_to_date_cents).toBe(max); // earned is NOT rewritten
    const claim = w.claimRow(d.claimId);
    expect(claim.subtotal_cents).toBe(amount);
    expect(claim.total_cents).toBe((claim.subtotal_cents as number) + (claim.tax_cents as number));
  });
  it("a full claim does not name the partial column (so it still inserts before migration 0120)", async () => {
    const w = await world();
    const d = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id]);
    expect("partial" in w.lines(d.claimId)[0]).toBe(false);
  });
  it("approving a partial claim reserves ONLY the partial amount; the remainder is claimable and the two sum to the full maximum", async () => {
    const w = await world();
    const max = await w.maxOf(w.dep.id);
    const a = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: 1000 } });
    await w.approve(a.claimId);
    expect((await previewClaim(w.db as never, ORG, w.projectId, [w.dep.id])).calc.lines[0].currentClaimCents).toBe(max - 1000);
    const b = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id]);
    await w.approve(b.claimId);
    expect((w.lines(a.claimId)[0].current_claim_cents as number) + (w.lines(b.claimId)[0].current_claim_cents as number)).toBe(max);
    expect(await code(createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id]))).toBeTruthy(); // nothing left: no further claim
  });
  it("two open partial drafts cannot both be approved against the same room (no duplicate reservation)", async () => {
    const w = await world();
    const max = await w.maxOf(w.dep.id);
    const big = Math.floor(max * 0.7);
    const a = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: big } });
    await submitClaimForApproval(w.db as never, ORG, w.projectId, a.claimId);
    const b = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: big + 1 } });
    await submitClaimForApproval(w.db as never, ORG, w.projectId, b.claimId);
    await approveClaim(w.db as never, ORG, "mgr@a", w.projectId, a.claimId);
    expect(await code(approveClaim(w.db as never, ORG, "mgr@a", w.projectId, b.claimId))).toBe("STALE_DRAFT"); // 0.7 + 0.7 > 1.0: refused, not double-reserved
    expect(w.claimRow(b.claimId).status).toBe("READY_FOR_APPROVAL");
  });
  it("an overclaim is refused at drafting and nothing is saved", async () => {
    const w = await world();
    const max = await w.maxOf(w.dep.id);
    expect(await code(createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: max + 1 } }))).toBe("PARTIAL_EXCEEDS_CLAIMABLE");
    expect(w.db.rows("project_claims").filter((c) => c.status === "DRAFT")).toHaveLength(0);
  });
  it("a partial draft whose approved completion later moves is STALE and approval is refused", async () => {
    const w = await world();
    const d = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: 1000 } });
    await submitClaimForApproval(w.db as never, ORG, w.projectId, d.claimId);
    await w.rec("Deposit / Commencement", "90"); // lowers approved completion -> earned changes
    expect(await code(approveClaim(w.db as never, ORG, "mgr@a", w.projectId, d.claimId))).toMatch(/STALE_DRAFT|COMPLETION_BELOW_BILLED/);
    expect(w.claimRow(d.claimId).status).toBe("READY_FOR_APPROVAL");
  });
  it("recalculating a partial draft keeps its partial amount (capped), not a silent full claim", async () => {
    const w = await world();
    const d = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: 1000 } });
    await w.rec("Deposit / Commencement", "95"); // makes the draft stale but 1000 is still claimable
    const r = await recalculateStaleDraft(w.db as never, ORG, "pm@a", w.projectId, d.claimId);
    expect(w.lines(r.newClaimId)[0]).toMatchObject({ current_claim_cents: 1000, partial: true });
  });
});

describe("partial amount parsing", () => {
  it("parses rands to cents and ignores blanks", () => {
    expect(parsePartialAmounts(["a", "b"], { a: "1234.50", b: "  " })).toEqual({ a: 123_450 });
  });
  it("refuses negatives, junk, zero, 3-decimals and amounts for stages not chosen", () => {
    for (const bad of ["-5", "abc", "0", "1.234", "1e3"]) expect(() => parsePartialAmounts(["a"], { a: bad })).toThrow();
    expect(() => parsePartialAmounts(["a"], { z: "10" })).toThrow(/not selected/);
  });
});

describe("partial claim on a database without migration 0120", () => {
  it("is refused before anything is written (no orphan draft), while full claims still work", async () => {
    const w = await world();
    (w.db as unknown as { failColumn?: string }).failColumn = "partial";
    const real = w.db.from.bind(w.db);
    (w.db as unknown as { from: unknown }).from = (t: string) => {
      const q = real(t) as Record<string, unknown>;
      if (t !== "project_claim_lines") return q;
      const select = (q.select as (c: string) => unknown).bind(q);
      q.select = (cols: string) => (/partial/.test(cols) ? { limit: async () => ({ data: null, error: { message: 'column "partial" does not exist' } }), eq: () => ({ eq: async () => ({ data: null, error: { message: 'column "partial" does not exist' } }) }) } : select(cols));
      return q;
    };
    await expect(createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id], undefined, { amountsCents: { [w.dep.id]: 1000 } })).rejects.toThrow(/migration 0120/);
    expect(w.db.rows("project_claims").filter((c) => c.status === "DRAFT")).toHaveLength(0);
    const full = await createClaimDraft(w.db as never, ORG, "pm@a", w.projectId, [w.dep.id]);
    expect(w.lines(full.claimId)).toHaveLength(1);
  });
});
