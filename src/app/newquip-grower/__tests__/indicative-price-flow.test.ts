/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { withAcceptedIncompleteCosting } from "@/newquip/grower/__tests__/golden";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";

// NQ-008A end to end: the REAL actions over an in-memory database with REAL role resolution (only the session is mocked). Proves the indicative price is captured at
// handoff, stays unchanged, is compared for the Estimator with server-stamped attribution, and never reaches a Rep.

let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "m" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "x.test" }) }));
import * as actions from "../actions";

const ORG = "org-nq";
type Who = "owner" | "rep" | "est" | "mgr";
const ACCOUNT: Record<Who, { userId: string; email: string; tier: "owner" | "member"; fn: string }> = {
  owner: { userId: "u-owner", email: "owner@a", tier: "owner", fn: "ADMINISTRATOR" },
  rep: { userId: "u-rep", email: "rep@a", tier: "member", fn: "REP" },
  est: { userId: "u-est", email: "est@a", tier: "member", fn: "ESTIMATOR" },
  mgr: { userId: "u-mgr", email: "mgr@a", tier: "member", fn: "MANAGER" },
};
const EMAILS: Record<string, string> = Object.fromEntries(Object.values(ACCOUNT).map((a) => [a.userId, a.email]));
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
// Authorisation tests, not costing tests: the sign-off/approval costing gate (S1a) is covered in rep-handoff.test.ts, so this fixture records the accepted-incomplete-costing exception like the other workflow fixtures.
const draft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft);
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);
const ALT = { source: "ALTERNATIVE" as const, name: "Joe Farmer", reason: "Confirmed by telephone" };

/** The signed-in identity: the session facts a real request would have. Everything else comes from the real role tables. */
function as(who: Who, orgId = ORG) {
  const a = ACCOUNT[who];
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId, userId: a.userId, email: a.email } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (a.tier === "member") throw new Error("Only an org owner or admin can do that."); return undefined as never; });
}

function world(opts: { strict?: boolean } = {}) {
  const d = new FakeDb();
  seedGoldenCatalogue(d as never, ORG);
  d.approvalsApplied = true; d.rolesApplied = true;
  installStaged(d);
  (d as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } };
  for (const a of Object.values(ACCOUNT)) {
    d.rows("org_members").push({ org_id: ORG, user_id: a.userId, role: a.tier });
    d.rows("org_functional_roles").push({ id: `r-${a.userId}`, org_id: ORG, user_id: a.userId, user_email: a.email, role: a.fn, assigned_by_email: "owner@a", assigned_at: "t" });
  }
  if (opts.strict) d.rows("approval_settings").push({ org_id: ORG, roles_enforced: true });
  return d;
}
const seedQuote = (state: "REP_DRAFT" | "ESTIMATOR_REVIEW", over: Record<string, unknown> = {}) => db.rows("newquip_quotes").push({
  id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state, draft, draft_hash: "h1",
  customer_confirmed_cents: state === "REP_DRAFT" ? null : total, customer_confirmed_by: state === "REP_DRAFT" ? null : "r", customer_confirmed_at: state === "REP_DRAFT" ? null : "t",
  handoff_by_email: state === "REP_DRAFT" ? null : "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
  approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t", ...over,
});
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>;



beforeEach(() => { db = world(); db.indicativeApplied = true; vi.clearAllMocks(); });

const snaps = () => db.rows("newquip_indicative_price_snapshots") as Record<string, any>[];
const viewOf = async (who: Who) => { as(who); const r = await actions.getGrowerQuoteAction("q1"); expect(r.error).toBeUndefined(); return r.data!; };
const handoff = async () => { as("rep"); const r = await actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT); expect(r.error).toBeUndefined(); };
const withInstall = (delta: number) => { const d = structuredClone(draft); d.estimator.charges.installation = (d.estimator.charges.installation ?? 0) + delta; return d; };

describe("NQ-008A: the indicative price is captured at handoff", () => {
  it("handoff stores ONE snapshot with the confirmed total, the rule version and the price source, in the same step as the state change", async () => {
    seedQuote("REP_DRAFT");
    await handoff();
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    expect(snaps()).toHaveLength(1);
    const s = snaps()[0];
    expect(s.seq).toBe(1);
    expect(s.total_ex_vat_cents).toBe(total);
    expect(s.captured_by_email).toBe("rep@a");
    expect(s.ruleset_version).toMatch(/^grower-house-v1/);
    expect(s.price_source_id).toBe("newquip_master_workbook_snapshot");
    expect(s.price_source_fingerprint).toMatch(/Master 05 Oct 2026/);
    expect(s.snapshot.internal.ruleSet.projectMarkupPctOnLandedCost).toBe(20);
  });
  it("if the capture fails the handoff does not happen: the quotation is still the Rep's draft and no snapshot exists", async () => {
    seedQuote("REP_DRAFT");
    db.failHandoffAfterInsert = true;
    as("rep");
    const r = await actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT);
    expect(r.ok).toBe(false);
    expect(quote().state).toBe("REP_DRAFT");
    expect(quote().customer_confirmed_cents).toBeNull();
    expect(snaps()).toHaveLength(0);
  });
  it("a double submit records one handoff and one snapshot", async () => {
    seedQuote("REP_DRAFT");
    await handoff();
    as("rep");
    const again = await actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT);
    expect(again.ok).toBe(false);
    expect(snaps()).toHaveLength(1);
  });
  it("before migration 0123 is applied the handoff works exactly as before (no snapshot), and the Estimator is told so", async () => {
    db.indicativeApplied = false;
    seedQuote("REP_DRAFT");
    await handoff();
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    const v = await viewOf("est");
    expect(v.indicativeComparison).toMatchObject({ basis: "amount_only", originalTotalCents: total, deltaCents: 0 });
    expect(v.indicativeComparison!.note).toMatch(/No indicative price snapshot was captured/);
  });
});

describe("NQ-008A: the Estimator's comparison", () => {
  it("unchanged: the Estimator sees the indicative amount, zero difference and nothing changed", async () => {
    seedQuote("REP_DRAFT"); await handoff();
    const c = (await viewOf("est")).indicativeComparison!;
    expect(c.basis).toBe("snapshot");
    expect([c.originalTotalCents, c.currentTotalCents, c.deltaCents]).toEqual([total, total, 0]);
    expect(c.rows.filter((r) => r.changed)).toEqual([]);
    expect(c.history).toHaveLength(1);
  });
  it("an Estimator change is attributed by the SERVER (actor + time), a forged stamp is ignored, the difference is exact, and the snapshot never changes", async () => {
    seedQuote("REP_DRAFT"); await handoff();
    const frozen = JSON.stringify(snaps()[0]);
    as("est");
    const changed = withInstall(25_000);
    changed.estimator.changeStamps = { "charges.installation": { by: "forged@evil", at: "2001-01-01T00:00:00.000Z", rev: 1 } };
    const saved = await actions.saveGrowerDraftAction("q1", changed);
    expect(saved.error).toBeUndefined();
    const stored = quote().draft.estimator.changeStamps["charges.installation"];
    expect(stored.by).toBe("est@a");
    expect(stored.rev).toBe(1);
    expect(Date.parse(stored.at)).toBeGreaterThan(Date.parse("2026-01-01"));
    const c = (await viewOf("est")).indicativeComparison!;
    const row = c.rows.find((r) => r.key === "charge:installation")!;
    expect(row.deltaCents).toBe(2_500_000);
    expect(row.changes).toEqual([{ label: "Charge: installation", by: "est@a", at: stored.at }]);
    expect(c.originalTotalCents).toBe(total);
    expect(c.deltaCents).toBe(c.currentTotalCents! - total);
    expect(c.deltaCents).toBe(2_500_000);
    expect(JSON.stringify(snaps()[0])).toBe(frozen); // the stored indicative snapshot is untouched by the later recalculation
    expect(snaps()).toHaveLength(1);
  });
  it("a price change returns the quotation to the Rep (existing rule); the comparison survives that, and a re-handoff adds a second snapshot without losing the first", async () => {
    seedQuote("REP_DRAFT"); await handoff();
    as("est"); expect((await actions.saveGrowerDraftAction("q1", withInstall(25_000))).error).toBeUndefined();
    expect(quote().state).toBe("REP_DRAFT");
    expect(quote().revision).toBe(2);
    const afterReturn = (await viewOf("est")).indicativeComparison!;
    expect(afterReturn.deltaCents).toBe(2_500_000); // still comparing against the revision-1 handoff
    const newTotal = total + 2_500_000;
    as("rep");
    expect((await actions.sendGrowerQuoteToEstimatorAction("q1", newTotal, ALT)).error).toBeUndefined();
    expect(snaps().map((s) => [s.seq, s.revision, s.total_ex_vat_cents])).toEqual([[1, 1, total], [2, 2, newTotal]]);
    const c = (await viewOf("est")).indicativeComparison!;
    expect([c.originalTotalCents, c.deltaCents]).toEqual([newTotal, 0]);
    expect(c.history.map((h) => h.totalCents)).toEqual([total, newTotal]);
    expect(c.rows.filter((r) => r.changed)).toEqual([]); // the earlier revision's stamps do not leak into this handoff
  });
});

describe("NQ-008A: a Rep never receives the confidential basis", () => {
  it("the Rep's payload has no comparison, no change stamps, no snapshot, no rule-set or cost basis - before or after an Estimator change", async () => {
    seedQuote("REP_DRAFT"); await handoff();
    const check = (v: unknown) => {
      const json = JSON.stringify(v);
      for (const banned of ["indicativeComparison", "changeStamps", "internal", "ruleSet", "newquip-grower-pricing", "estimatedCostCents", "priceSourceFingerprint", "snapshot_hash", "landed", "markup"]) expect(json, banned).not.toContain(banned);
    };
    check(await viewOf("rep"));
    as("est"); await actions.saveGrowerDraftAction("q1", withInstall(25_000));
    expect(quote().draft.estimator.changeStamps).toBeTruthy(); // the stamp exists in storage...
    check(await viewOf("rep")); // ...but the Rep's view of the quotation does not carry it
  });
  it("the Estimator, Manager and owner (cost-entitled) do receive the comparison", async () => {
    seedQuote("REP_DRAFT"); await handoff();
    for (const w of ["est", "mgr", "owner"] as Who[]) expect((await viewOf(w)).indicativeComparison?.basis, w).toBe("snapshot");
  });
  it("an approved quotation has no indicative comparison (its price is the sealed baseline)", async () => {
    seedQuote("REP_DRAFT"); await handoff();
    as("est"); expect((await actions.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    as("mgr"); expect((await actions.approveGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    expect((await viewOf("est")).indicativeComparison).toBeUndefined();
  });
});
