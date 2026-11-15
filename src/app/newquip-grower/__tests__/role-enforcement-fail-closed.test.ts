/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { createQuote, saveDraft, sendToEstimator } from "@/lib/newquip-quotes/quote-store";
import { canSeeCosts, resolveRoles, strictRoles, emailsWithRole } from "@/lib/approvals/role-store";

// ROLE ENFORCEMENT, FAIL CLOSED (NewQuip organisation). The REAL server actions and the REAL role resolution run over an in-memory database; only the session (who is signed in,
// and whether they are an org owner/admin) is replaced. Explicit assignments are authoritative; an owner/admin tier, a missing or switched-off approval_settings row, an unreadable
// settings table or an unavailable roles table must never widen access. The pre-existing wide behaviour is unchanged for every OTHER organisation.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { testPriceSource: src } = await import("@/newquip/grower/__tests__/test-snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(), withholdCost }) };
});
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "m" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "x.test" }) }));
import * as actions from "../actions";
import * as pricing from "../pricing-actions";

const NQ = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const OTHER = "11111111-2222-3333-4444-555555555555";
type Acct = { userId: string; email: string; tier: "owner" | "admin" | "member"; fns: string[] };
const A: Record<string, Acct> = {
  rep: { userId: "u-rep", email: "rep@a", tier: "member", fns: ["REP"] },
  est: { userId: "u-est", email: "est@a", tier: "member", fns: ["ESTIMATOR"] },
  mgr: { userId: "u-mgr", email: "mgr@a", tier: "member", fns: ["MANAGER"] },
  ownerAdminOnly: { userId: "u-o1", email: "o1@a", tier: "owner", fns: ["ADMINISTRATOR"] },
  adminRepOnly: { userId: "u-o2", email: "o2@a", tier: "admin", fns: ["REP"] },
  adminNoRoles: { userId: "u-o3", email: "o3@a", tier: "admin", fns: [] },
  memberNoRoles: { userId: "u-m1", email: "m1@a", tier: "member", fns: [] },
};
const as = (k: string, org = NQ) => {
  const a = A[k];
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: org, userId: a.userId, email: a.email } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: org, userId: a.userId, email: a.email } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (a.tier === "member") throw new Error("not admin"); return undefined as never; });
};
const seed = (org: string) => {
  for (const a of Object.values(A)) {
    db.rows("org_members").push({ org_id: org, user_id: a.userId, role: a.tier });
    for (const fn of a.fns) db.rows("org_functional_roles").push({ id: `r-${org}-${a.userId}-${fn}`, org_id: org, user_id: a.userId, user_email: a.email, role: fn, assigned_by_email: "x", assigned_at: "t" });
  }
};
const viewer = async (k: string, org = NQ) => { as(k, org); const r = await actions.getGrowerViewerAction(); return r.data as { roles: string[]; canViewCommercials: boolean }; };
const emptyApproval = () => { db.approvalsApplied = true; db.rolesApplied = true; };

beforeEach(() => { db = new FakeDb(); emptyApproval(); (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: Object.values(A).find((a) => a.userId === id)?.email } } }) } }; seed(NQ); });

describe("explicit assignments are authoritative in the NewQuip organisation", () => {
  it("a Rep sees no cost and holds only Rep", async () => { expect(await viewer("rep")).toEqual({ roles: ["rep"], canViewCommercials: false }); });
  it("an Estimator holds only Estimator; a Manager only Manager (both may see cost)", async () => {
    expect(await viewer("est")).toEqual({ roles: ["estimator"], canViewCommercials: true });
    expect(await viewer("mgr")).toEqual({ roles: ["manager"], canViewCommercials: true });
  });
  it("an org OWNER whose only assignment is Administrator gets NO process role and NO cost visibility", async () => {
    expect(await viewer("ownerAdminOnly")).toEqual({ roles: [], canViewCommercials: false });
  });
  it("an org ADMIN explicitly assigned Rep only does not gain Estimator or Manager rights, and does not see cost", async () => {
    expect(await viewer("adminRepOnly")).toEqual({ roles: ["rep"], canViewCommercials: false });
  });
});

describe("missing or invalid configuration never widens access (NewQuip organisation)", () => {
  it("an unassigned member gets nothing (not the Rep + Estimator tier default)", async () => { expect(await viewer("memberNoRoles")).toEqual({ roles: [], canViewCommercials: false }); });
  it("an unassigned owner/admin gets nothing (not all three roles and cost visibility)", async () => { expect(await viewer("adminNoRoles")).toEqual({ roles: [], canViewCommercials: false }); });
  it("an approval_settings row that switches enforcement OFF is ignored", async () => {
    db.rows("approval_settings").push({ org_id: NQ, roles_enforced: false });
    expect(await strictRoles(db as never, NQ)).toBe(true);
    expect(await viewer("adminNoRoles")).toEqual({ roles: [], canViewCommercials: false });
  });
  it("an unreadable approval_settings table is strict, not wide", async () => {
    const broken = { from: (t: string) => (t === "approval_settings" ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) } : (db as any).from(t)) } as any;
    expect(await strictRoles(broken, NQ)).toBe(true);
  });
  it("with the roles table unavailable (migration absent) the NewQuip organisation gets no process roles", async () => {
    db.rolesApplied = false;
    expect([...(await resolveRoles(db as never, NQ, "u-m1", false))]).toEqual([]);
    expect([...(await resolveRoles(db as never, NQ, "u-o3", true))]).toEqual(["ADMINISTRATOR"]);
  });
  it("named-approver lookup follows the same rule: nobody without an explicit role is listed as a Manager or Estimator", async () => {
    expect(await emailsWithRole(db as never, NQ, "MANAGER")).toEqual(["mgr@a"]);
    expect(await emailsWithRole(db as never, NQ, "ESTIMATOR")).toEqual(["est@a"]);
  });
});

describe("cost visibility: only an explicit Estimator or Manager (the read-only diagnostic keeps its verified-admin rule)", () => {
  it("canSeeCosts matrix", async () => {
    const c = (k: string, opts?: { adminTierOverridesAssignments?: boolean }) => canSeeCosts(db as never, NQ, A[k].userId, A[k].tier !== "member", opts);
    expect(await c("rep")).toBe(false);
    expect(await c("est")).toBe(true);
    expect(await c("mgr")).toBe(true);
    expect(await c("ownerAdminOnly")).toBe(false);
    expect(await c("adminRepOnly")).toBe(false);
    expect(await c("adminNoRoles")).toBe(false);
    expect(await c("memberNoRoles")).toBe(false);
    expect(await c("ownerAdminOnly", { adminTierOverridesAssignments: true })).toBe(true); // authoriseDiagnostic: requireOrgAdmin has already passed
    expect(await c("rep", { adminTierOverridesAssignments: true })).toBe(false); // a non-admin tier never gains it
  });
});

describe("other organisations keep the existing behaviour (this change is NewQuip-only)", () => {
  beforeEach(() => { seed(OTHER); });
  it("an unassigned member is Rep + Estimator and an unassigned admin has every role in a different organisation", async () => {
    expect([...(await resolveRoles(db as never, OTHER, "u-m1", false))].sort()).toEqual(["ESTIMATOR", "REP"]);
    expect([...(await resolveRoles(db as never, OTHER, "u-o3", true))].sort()).toEqual(["ADMINISTRATOR", "ESTIMATOR", "MANAGER", "REP"]);
    expect(await strictRoles(db as never, OTHER)).toBe(false);
    expect(await canSeeCosts(db as never, OTHER, "u-o1", true)).toBe(true);
  });
});

describe("the pricing Server Actions refuse callers the policy excludes (nothing is written)", () => {
  let qid = "";
  beforeEach(async () => {
    seedGoldenCatalogue(db as never, NQ); db.indicativeApplied = true; db.pricingApplied = true;
    const ctx = { priceSource: testPriceSource(), withholdCost: true };
    const d = readyDraft();
    const { id } = await createQuote(db as never, NQ, "rep@a");
    await saveDraft(db as never, NQ, rolesFor("member"), id, d);
    await sendToEstimator(db as never, NQ, new Set(["rep"] as const) as never, "rep@a", id, ctx, { confirmedAmountCents: Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100), confirmedBy: "Farmer Joe" });
    qid = id;
  });
  const snapshot = () => JSON.stringify([db.rows("newquip_quotes"), db.rows("newquip_pricing_revisions")]);
  it.each(["rep", "adminRepOnly", "ownerAdminOnly", "adminNoRoles", "memberNoRoles"])("%s cannot read, enter or verify pricing", async (k) => {
    as(k);
    const before = snapshot();
    const r1 = await pricing.getEstimatorPricingAction(qid);
    const r2 = await pricing.applyEstimatorPricingAction(qid, {} as never, "reason text here", null);
    const r3 = await pricing.verifyEstimatorCostsAction(qid, [], "evidence");
    for (const r of [r1, r2, r3]) { expect(r.ok).toBe(false); expect((r as any).error).not.toMatch(/not found/i); }
    expect(snapshot()).toBe(before);
  });
  it("an Estimator may read the workspace (the control: refusal above is the policy, not a broken fixture)", async () => {
    as("est");
    expect((await pricing.getEstimatorPricingAction(qid)).ok).toBe(true);
  });
});
