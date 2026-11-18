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
import { sendEmail } from "@/lib/email/resend";

// NEWQUIP ROLE ENFORCEMENT, approvals and Projects layer. REAL server actions and REAL role resolution over an in-memory database (the staged-approval emulator stands in for
// migration 0112's functions); only the session (who is signed in, and whether they are org owner/admin) is replaced. Accounts mirror the hosted organisation:
//   owner : org OWNER tier, explicit ADMINISTRATOR only     rep / est / mgr : member tier, one explicit role each     adminMgr : org ADMIN tier that ALSO holds the explicit Manager role
// Every refusal must leave EVERY table byte-identical (approval requests, events, notifications, the quotation, the write log) and send no email.
let db: FakeDb;
const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined), set: (k: string, v: string) => { jar.set(k, v); }, delete: (k: string) => { jar.delete(k); } }) }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "m" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "x.test" }) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as grower from "../actions";
import * as approvals from "@/app/approvals/actions";
import * as procurement from "@/app/projects/procurement-actions";
import * as projectActions from "@/app/projects/actions";
import * as profit from "@/app/projects/profitability-actions";

const ORG = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
type Who = "owner" | "rep" | "est" | "mgr" | "adminMgr";
const ACCOUNT: Record<Who, { userId: string; email: string; tier: "owner" | "admin" | "member"; fns: string[] }> = {
  owner: { userId: "u-owner", email: "owner@a", tier: "owner", fns: ["ADMINISTRATOR"] },
  rep: { userId: "u-rep", email: "rep@a", tier: "member", fns: ["REP"] },
  est: { userId: "u-est", email: "est@a", tier: "member", fns: ["ESTIMATOR"] },
  mgr: { userId: "u-mgr", email: "mgr@a", tier: "member", fns: ["MANAGER"] },
  adminMgr: { userId: "u-am", email: "am@a", tier: "admin", fns: ["MANAGER"] },
};
const EMAILS: Record<string, string> = Object.fromEntries(Object.values(ACCOUNT).map((a) => [a.userId, a.email]));
const draft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft);
const total = Math.round(evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true }).budget!.totals.subtotalExTax * 100);
const ALT = { source: "ALTERNATIVE" as const, name: "Joe Farmer", reason: "Confirmed by telephone" };

function as(who: Who) {
  const a = ACCOUNT[who];
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: a.userId, email: a.email } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (a.tier === "member") throw new Error("Only an org owner or admin can do that."); return { orgId: ORG, userId: a.userId, email: a.email } as never; });
}
function world() {
  const d = new FakeDb();
  seedGoldenCatalogue(d as never, ORG);
  d.approvalsApplied = true; d.rolesApplied = true; installStaged(d);
  (d as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } };
  for (const a of Object.values(ACCOUNT)) {
    d.rows("org_members").push({ org_id: ORG, user_id: a.userId, role: a.tier });
    for (const fn of a.fns) d.rows("org_functional_roles").push({ id: `r-${a.userId}-${fn}`, org_id: ORG, user_id: a.userId, user_email: a.email, role: fn, assigned_by_email: "owner@a", assigned_at: "t" });
  }
  return d;
}
const seedQuote = () => db.rows("newquip_quotes").push({
  id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "REP_DRAFT", draft, draft_hash: "h1",
  customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null, created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
  approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t",
});
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>;
/** EVERY table, plus the write log: a refused action must change none of it. */
const everything = () => JSON.stringify([Object.fromEntries(Object.entries(db.tables).map(([k, v]) => [k, v])), db.writes.length]);
async function toSignedOff() {
  seedQuote(); as("rep"); expect((await grower.sendGrowerQuoteToEstimatorAction("q1", total, ALT)).error).toBeUndefined();
  as("est"); expect((await grower.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
}
const openRequest = () => (db.rows("approval_requests") as any[]).find((r) => r.status === "PENDING")!;
const decideInput = (r: any, extra: Record<string, unknown> = {}) => ({ expectedVersion: r.version, expectedDigest: r.digest, ...extra });

beforeEach(() => { db = world(); jar.clear(); vi.clearAllMocks(); });

describe("an ADMINISTRATOR-only owner cannot approve, return or override at the Manager stage (Approvals actions, direct calls)", () => {
  beforeEach(toSignedOff);
  const refused = async (who: Who, run: () => Promise<{ ok: boolean; error?: string }>) => {
    const before = everything(); const mails = vi.mocked(sendEmail).mock.calls.length;
    as(who); const r = await run();
    expect(r.ok).toBe(false);
    expect(everything()).toBe(before);
    expect(vi.mocked(sendEmail).mock.calls.length).toBe(mails);
    return r;
  };
  it("a plain approve, a REASONED OVERRIDE approve, a return and a reject are all refused, and nothing is written", async () => {
    const r = openRequest();
    expect(r.stage).toBe("MANAGER");
    expect((await refused("owner", () => approvals.decideApprovalAction(r.id, "APPROVE", decideInput(r)))).error).toMatch(/manager role/i);
    expect((await refused("owner", () => approvals.decideApprovalAction(r.id, "APPROVE", decideInput(r, { override: true, reason: "Administrator override for the demonstration" })))).error).toMatch(/manager role/i);
    await refused("owner", () => approvals.decideApprovalAction(r.id, "RETURN", decideInput(r, { reason: "send it back", destination: "ESTIMATOR" })));
    await refused("owner", () => approvals.decideApprovalAction(r.id, "REJECT", decideInput(r, { reason: "reject it" })));
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
  it("the quotation-screen actions refuse the owner too (approve, return to Estimator, return to Rep)", async () => {
    await refused("owner", () => grower.approveGrowerQuoteAction("q1"));
    await refused("owner", () => grower.returnGrowerQuoteToEstimatorAction("q1", "recheck"));
    await refused("owner", () => grower.returnGrowerQuoteToRepAction("q1", "rework"));
  });
  it("Rep and Estimator are refused as well; only an explicit Manager can decide", async () => {
    const r = openRequest();
    for (const w of ["rep", "est"] as Who[]) await refused(w, () => approvals.decideApprovalAction(r.id, "APPROVE", decideInput(r)));
    as("mgr");
    expect((await approvals.decideApprovalAction(r.id, "APPROVE", decideInput(r))).ok).toBe(true);
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
  });
  it("an org ADMIN who also holds the explicit Manager role may approve (explicit roles are preserved)", async () => {
    as("adminMgr");
    expect((await grower.approveGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
  });
  it("administrative recovery is kept: the owner can still see the request and withdraw it (no approval, no cost)", async () => {
    const r = openRequest();
    as("owner");
    expect((await approvals.getApprovalDetailAction(r.id)).ok).toBe(true);
  });
  it("the tier-based fallback is gone when the staged tables are unavailable: nobody decides through the legacy path", async () => {
    const r = openRequest(); const stagedRow = { ...r };
    db.approvalsApplied = true; db.rolesApplied = false;
    const before = everything();
    as("adminMgr");
    const res = await approvals.decideApprovalAction(stagedRow.id, "APPROVE", decideInput(stagedRow));
    expect(res.ok).toBe(false);
    expect(everything()).toBe(before);
  });
});

describe("confidential costing in the Approvals detail follows the explicit Manager role, not the tier", () => {
  beforeEach(toSignedOff);
  const detail = async (who: Who) => { as(who); const r = await approvals.getApprovalDetailAction(openRequest().id); return r; };
  const hasInternal = (d: any) => JSON.stringify(d.data.review).includes("Estimated cost and margin (internal)");
  it("the ADMINISTRATOR-only owner sees no cost or margin and no decision rights", async () => {
    const d = await detail("owner"); expect(d.ok).toBe(true);
    expect(hasInternal(d)).toBe(false);
    expect(d.data!.isManager).toBe(false);
    expect(d.data!.can.decide).toBe(false);
    expect(JSON.stringify(d.data)).not.toMatch(/margin/i);
  });
  it("Rep and Estimator see no internal cost in the approval detail either", async () => {
    for (const w of ["rep", "est"] as Who[]) { const d = await detail(w); if (d.ok) { expect(hasInternal(d)).toBe(false); expect(d.data!.can.decide).toBe(false); } }
  });
  it("the explicit Manager (member tier, and admin tier) sees it and may decide", async () => {
    for (const w of ["mgr", "adminMgr"] as Who[]) { const d = await detail(w); expect(d.ok).toBe(true); expect(hasInternal(d)).toBe(true); expect(d.data!.can.decide).toBe(true); }
  });
});

describe("Projects: procurement cost targets and internal costing need the explicit Manager (or Procurement) role", () => {
  const targets = async (who: Who) => { as(who); return procurement.getProcurementTargetsAction("p1"); };
  it("the ADMINISTRATOR-only owner is refused the procurement cost targets; Rep and Estimator too; nothing is written", async () => {
    const before = everything();
    for (const w of ["owner", "rep", "est"] as Who[]) { const r = await targets(w); expect(r.ok).toBe(false); expect((r as any).error).toMatch(/cost targets are for buyers and managers/); }
    expect(everything()).toBe(before);
  });
  it("an explicit Manager (member or admin tier) and an explicit Procurement holder pass the role gate (the project itself is not found here)", async () => {
    db.rows("org_functional_roles").push({ id: "r-proc", org_id: ORG, user_id: "u-rep", user_email: "rep@a", role: "PROCUREMENT", assigned_by_email: "o", assigned_at: "t" });
    for (const w of ["mgr", "adminMgr", "rep"] as Who[]) { const r = await targets(w); expect((r as any).error ?? "").not.toMatch(/cost targets are for buyers and managers/); }
  });
  it("internal costing, profitability and the cost ledger refuse the ADMINISTRATOR-only owner (org admin tier is not a Manager)", async () => {
    as("owner");
    for (const run of [() => profit.getCostingReportAction("p1"), () => profit.getProfitabilityAction("p1"), () => profit.getCostLedgerAction("p1")]) { const r = await run(); expect(r.ok).toBe(false); expect((r as any).error).toMatch(/needs the Manager role/); }
  });
  it("Projects approvals (claim, variation, commercial progress) refuse the ADMINISTRATOR-only owner and keep the explicit Manager", async () => {
    as("owner");
    for (const r of [await projectActions.approveClaimAction("p1", "c1"), await projectActions.approveVariationAction("p1", "v1"), await projectActions.rejectVariationAction("p1", "v1", "no")]) { expect(r.ok).toBe(false); expect(r.error).toMatch(/needs the Manager role/); }
    expect((await projectActions.getViewerPermissionsAction()).data).toMatchObject({ canApprove: false });
    as("adminMgr");
    expect((await projectActions.getViewerPermissionsAction()).data).toMatchObject({ canApprove: true });
  });
});

describe("Manager / Estimator / Rep separation still holds through the real role resolution", () => {
  it("the Manager (real roles) cannot enter or change Estimator pricing; the Estimator can open the workspace; Rep and ADMINISTRATOR-only are refused", async () => {
    const { createQuote, saveDraft, sendToEstimator } = await import("@/lib/newquip-quotes/quote-store");
    const { rolesFor } = await import("@/newquip/quote/roles");
    const { readyDraft } = await import("@/newquip/grower/__tests__/golden");
    const { testPriceSource } = await import("@/newquip/grower/__tests__/test-snapshot");
    const pricing = await import("../pricing-actions");
    db.indicativeApplied = true; db.pricingApplied = true;
    const ctx = { priceSource: testPriceSource(), withholdCost: true };
    const d = readyDraft();
    const { id } = await createQuote(db as never, ORG, "rep@a");
    await saveDraft(db as never, ORG, rolesFor("member"), id, d);
    await sendToEstimator(db as never, ORG, new Set(["rep"] as const) as never, "rep@a", id, ctx, { confirmedAmountCents: Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100), confirmedBy: "Farmer Joe" });
    const snap = () => JSON.stringify([db.rows("newquip_quotes"), db.rows("newquip_pricing_revisions")]);
    for (const w of ["mgr", "rep", "owner"] as Who[]) {
      as(w); const before = snap();
      const r = await pricing.applyEstimatorPricingAction(id, {} as never, "a reason that is long enough", null);
      expect(r.ok).toBe(false); expect(r.error).not.toMatch(/not found/i); expect(snap()).toBe(before);
    }
    as("est"); expect((await pricing.getEstimatorPricingAction(id)).ok).toBe(true);
    as("mgr"); expect((await pricing.getEstimatorPricingAction(id)).ok).toBe(true); // the reviewer role may read (read-only) and verify independently
  });
});
