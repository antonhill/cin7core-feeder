// REGRESSION (Phase G blocker): a NEW quotation approved by a manager and turned into a project through the real server action must be created with the
// NewQuip 40/55/5 schedule - not the legacy six-stage one. This drives the action the browser calls (createProjectFromGrowerQuoteAction), through the
// real quote store, the real quote->project adapter and the real project store, over the in-memory database. Only authentication and the database
// client are substituted; nothing about the schedule is.
//
// FAIL-BEFORE-FIX: the "defect reproduction" test below asserts the stages purely from what is persisted, so it also runs unchanged against the
// pre-Phase-A code (origin/main 09e1aba), where it fails with the six legacy stages - the exact symptom reported.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { buildAcceptedBaseline } from "@/newquip/quote/baseline";

const ORG = "org-nq";
const h = vi.hoisted(() => ({ db: null as unknown, logs: [] as Array<{ action: string; detail: Record<string, unknown> }> }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => h.db }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: async () => ({ orgId: "org-nq" }) }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: async () => ({ orgId: "org-nq", userId: "u1", email: "m@nq" }) }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: async () => ({ orgId: "org-nq" }) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: async (_db: unknown, e: { action: string; detail: Record<string, unknown> }) => { h.logs.push(e); } }));

import { createProjectFromGrowerQuoteAction } from "../actions";

const R = (n: number) => n * 100;
const APPROVALS = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };
const ctx = (withholdCost: boolean) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost });
const draft = applyDemoDefaults(emptyDraft()).draft;
const approvedFor = (ref: string) => buildAcceptedBaseline({ quoteRef: ref, revision: 1, draft, evaluation: evaluateDraft(draft, ctx(true)), marginEvaluation: evaluateDraft(draft, ctx(false)), approvals: APPROVALS });
const approved = approvedFor("NQ-Q-0005");

/** A brand-new quotation that a manager has just approved (the state right before "Create Project"). */
function seedApprovedQuote(db: FakeDb, id: string, ref: string) {
  const sealed = approvedFor(ref); // each quotation carries its own sealed baseline
  db.rows("newquip_quotes").push({
    id, org_id: ORG, quote_ref: ref, revision: 1, customer_name: "Test Customer", site_name: "Test Farm", quote_type: "project", state: "MANAGER_APPROVED_FINAL", draft,
    accepted_baseline: sealed.baseline, baseline_hash: sealed.hash, contract_cents: sealed.baseline.contractCents,
    project_id: null, created_at: "2026-10-28T19:26:47Z", updated_at: "2026-10-28T19:29:12Z",
  });
}
const stagesOf = (db: FakeDb, projectId: string) => db.rows("project_stages").filter((s) => s.project_id === projectId).sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).map((s) => [s.name, Number(s.value_cents)]);

beforeEach(() => { h.db = new FakeDb(); h.logs.length = 0; });

describe("quote -> project boundary (the real server action)", () => {
  it("DEFECT REPRODUCTION: a new R10m quotation creates a project with R4m / R5.5m / R500k, not the six legacy stages", async () => {
    const db = h.db as FakeDb; seedApprovedQuote(db, "q5", "NQ-Q-0005");
    expect(approved.baseline.contractCents).toBe(R(10_000_000));
    const r = await createProjectFromGrowerQuoteAction("q5"); // no schedule chosen: the default
    expect(r.ok).toBe(true);
    expect(stagesOf(db, r.data!.projectId)).toEqual([["Deposit", R(4_000_000)], ["Delivery", R(5_500_000)], ["Installation", R(500_000)]]);
  });
  it("the action reports what was actually persisted, and the audit entry records the schedule used", async () => {
    const db = h.db as FakeDb; seedApprovedQuote(db, "q5", "NQ-Q-0005");
    const r = await createProjectFromGrowerQuoteAction("q5");
    expect(r.data).toMatchObject({ created: true, billingSchedule: "NewQuip standard 40/55/5", stages: [{ name: "Deposit", valueCents: R(4_000_000) }, { name: "Delivery", valueCents: R(5_500_000) }, { name: "Installation", valueCents: R(500_000) }] });
    expect(h.logs.find((l) => l.action === "newquip.project_created")?.detail).toMatchObject({ billingSchedule: "NewQuip standard 40/55/5", stages: ["Deposit 40.00%", "Delivery 55.00%", "Installation 5.00%"] });
  });
  it("an explicit legacy six-stage selection is honoured", async () => {
    const db = h.db as FakeDb; seedApprovedQuote(db, "q5", "NQ-Q-0005");
    const r = await createProjectFromGrowerQuoteAction("q5", { preset: "SIX_STAGE" });
    expect(stagesOf(db, r.data!.projectId).map(([n, v]) => [n, v])).toEqual([["Deposit", R(1_000_000)], ["Manufacturing", R(3_000_000)], ["Equipment Ready", R(2_000_000)], ["Delivery", R(2_000_000)], ["Installation", R(1_500_000)], ["Commissioning", R(500_000)]]);
    expect(r.data!.billingSchedule).toBe("Six-stage (10/30/20/20/15/5)");
  });
  it("a custom schedule is honoured and must total 100% (a bad one creates nothing)", async () => {
    const db = h.db as FakeDb; seedApprovedQuote(db, "q5", "NQ-Q-0005"); seedApprovedQuote(db, "q6", "NQ-Q-0006");
    const bad = await createProjectFromGrowerQuoteAction("q5", { preset: "CUSTOM", stages: [{ name: "A", percent: "60" }, { name: "B", percent: "30" }] });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/Billing schedule.*90\.00%/) });
    expect(db.rows("projects")).toHaveLength(0);
    const ok = await createProjectFromGrowerQuoteAction("q6", { preset: "CUSTOM", stages: [{ name: "Deposit", percent: "30" }, { name: "Delivery 1", percent: "35" }, { name: "Delivery 2", percent: "30" }, { name: "Install", percent: "5" }] });
    expect(ok.error).toBeUndefined();
    expect(stagesOf(db, ok.data!.projectId).map(([, v]) => v)).toEqual([R(3_000_000), R(3_500_000), R(3_000_000), R(500_000)]);
  });
  it("reloading / calling again never changes the project or silently swaps in another schedule", async () => {
    const db = h.db as FakeDb; seedApprovedQuote(db, "q5", "NQ-Q-0005");
    const first = await createProjectFromGrowerQuoteAction("q5");
    const again = await createProjectFromGrowerQuoteAction("q5", { preset: "SIX_STAGE" }); // a later attempt with a different choice
    expect(again.data).toMatchObject({ created: false, projectId: first.data!.projectId, billingSchedule: null });
    expect(again.data!.stages).toEqual(first.data!.stages); // what is stored is reported, whatever was asked
    expect(db.rows("projects")).toHaveLength(1);
    expect(db.rows("project_stages")).toHaveLength(3);
    expect(db.rows("newquip_quotes")[0].project_id).toBe(first.data!.projectId);
  });
  it("existing projects are untouched, and only the new quotation's project is created; no Cin7 table is written", async () => {
    const db = h.db as FakeDb; seedApprovedQuote(db, "q5", "NQ-Q-0005");
    db.rows("projects").push({ id: "old", org_id: ORG, project_reference: "PRJ-NQ-Q-0001", originating_quote_ref: "NQ-Q-0001", status: "ACTIVE", billing_scope: "BASE" });
    for (const [i, [n, v]] of [["Deposit", 100], ["Manufacturing", 300], ["Equipment Ready", 200], ["Delivery", 200], ["Installation", 150], ["Commissioning", 50]].entries()) db.rows("project_stages").push({ id: `s${i}`, org_id: ORG, project_id: "old", sort_order: i + 1, name: n, value_cents: v });
    const oldSnapshot = JSON.stringify([db.rows("projects")[0], db.rows("project_stages").slice()]);
    await createProjectFromGrowerQuoteAction("q5");
    expect(JSON.stringify([db.rows("projects")[0], db.rows("project_stages").filter((s) => s.project_id === "old")])).toBe(oldSnapshot);
    expect(stagesOf(db, "old")).toHaveLength(6);
    const written = new Set(db.writes.map((w) => w.table));
    for (const t of written) expect(t).not.toMatch(/cin7|posting|sale_link|sale_creation/);
  });
  it("another organisation's quotation cannot be turned into a project through this action", async () => {
    const db = h.db as FakeDb; seedApprovedQuote(db, "q5", "NQ-Q-0005"); db.rows("newquip_quotes")[0].org_id = "someone-else";
    expect(await createProjectFromGrowerQuoteAction("q5")).toMatchObject({ ok: false, error: "Quote not found." });
    expect(db.rows("projects")).toHaveLength(0);
  });
});
