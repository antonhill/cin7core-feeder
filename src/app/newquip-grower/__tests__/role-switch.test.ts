/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { logActivity } from "@/lib/activity-log";

// UX-006h: SERVER-SIDE NEGATIVE AUTHORISATION for the real hosted account shape. The REAL actions run over an in-memory database; the role tables
// (org_functional_roles) are seeded exactly like the NewQuip POC organisation - ONE explicit functional role per account - and the REAL role
// resolution (authoriseActor -> resolveRoles / effectiveRoles / toQuoteRoles / canSeeCosts) decides. Nothing about roles is mocked: only the session
// (who is signed in and whether they are an org owner/admin) is. Every cross-role call must be REFUSED with no state change and no write.
//
//   owner  : org OWNER tier, explicit ADMINISTRATOR   (requireOrgAdmin passes)
//   rep    : member tier, explicit REP
//   est    : member tier, explicit ESTIMATOR
//   mgr    : member tier, explicit MANAGER
//
// PATH: these tests run the STAGED approval path (migration 0112 present), which the hosted organisation uses (org_functional_roles exists). On the staged
// path the stage's own role decides sign-off/approve/return (policy.ts), which is STRICTER than the pure workflow table: RETURN_TO_REP lists estimator AND
// manager in workflow.ts, but at estimator review a Manager-only account is refused by the staged policy (tested below). The pure table is in
// four-account-capability.test.ts. Tests tagged [STATE] check the state machine (wrong stage), not role isolation; [ROLE] tests check the caller's role.

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
import * as actions from "../actions";
import { switchActiveRoleAction } from "@/app/approvals/role-actions";
import { signActiveRole } from "@/lib/approvals/active-role-token";
import { ACTIVE_ROLE_COOKIE } from "@/lib/approvals/active-role";
import { resolveSwitchState } from "@/lib/approvals/role-switch-store";

// POC ROLE SWITCH. The REAL actions, role resolution and approval policy run over an in-memory database. Only the session (who is signed in, org admin or not)
// and the cookie jar are mocked. Shirnel holds REP + ESTIMATOR + MANAGER and is on the server allowlist; René holds ESTIMATOR only.
const ORG = "e1aea782-d095-47ad-90fb-4fa65c9bf855"; // the real NewQuip POC organisation id (eligibility is bound to it)
type Who = "shirnel" | "shirnelOwner" | "rene" | "rep" | "mgr" | "intruder";
const ACCOUNT: Record<Who, { userId: string; email: string; tier: "owner" | "member"; fns: string[] }> = {
  shirnel: { userId: "u-sh", email: "shirnel@a", tier: "member", fns: ["REP", "ESTIMATOR", "MANAGER"] },
  shirnelOwner: { userId: "u-sho", email: "shirnel-owner@a", tier: "owner", fns: ["REP", "ESTIMATOR", "MANAGER"] },
  rene: { userId: "u-rene", email: "rene@a", tier: "member", fns: ["ESTIMATOR"] },
  rep: { userId: "u-rep", email: "rep@a", tier: "member", fns: ["REP"] },
  mgr: { userId: "u-mgr", email: "mgr@a", tier: "member", fns: ["MANAGER"] },
  intruder: { userId: "u-int", email: "intruder@a", tier: "member", fns: ["REP", "ESTIMATOR", "MANAGER"] }, // three roles but NOT on the allowlist
};
const EMAILS: Record<string, string> = Object.fromEntries(Object.values(ACCOUNT).map((a) => [a.userId, a.email]));
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
const draft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft);
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);
const ALT = { source: "ALTERNATIVE" as const, name: "Joe Farmer", reason: "Confirmed by telephone" };

function as(who: Who) {
  const a = ACCOUNT[who];
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG, userId: a.userId, email: a.email } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: a.userId, email: a.email } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (a.tier === "member") throw new Error("Only an org owner or admin can do that."); return undefined as never; });
}
function world() {
  const d = new FakeDb();
  seedGoldenCatalogue(d as never, ORG);
  d.approvalsApplied = true; d.rolesApplied = true;
  installStaged(d);
  (d as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } };
  for (const a of Object.values(ACCOUNT)) {
    d.rows("org_members").push({ org_id: ORG, user_id: a.userId, role: a.tier });
    for (const fn of a.fns) d.rows("org_functional_roles").push({ id: `r-${a.userId}-${fn}`, org_id: ORG, user_id: a.userId, user_email: a.email, role: fn, assigned_by_email: "owner@a", assigned_at: "t" });
  }
  return d;
}
const seedQuote = (state: "REP_DRAFT" | "ESTIMATOR_REVIEW") => db.rows("newquip_quotes").push({
  id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state, draft, draft_hash: "h1",
  customer_confirmed_cents: state === "REP_DRAFT" ? null : total, customer_confirmed_by: state === "REP_DRAFT" ? null : "r", customer_confirmed_at: state === "REP_DRAFT" ? null : "t",
  handoff_by_email: state === "REP_DRAFT" ? null : "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
  approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t",
});
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>;
const viewer = async (w: Who) => { as(w); return (await actions.getGrowerViewerAction()).data! as { roles: string[]; canViewCommercials: boolean };
};
const switchTo = async (w: Who, role: string) => { as(w); return switchActiveRoleAction(role); };
const auditCalls = () => vi.mocked(logActivity).mock.calls.map((c) => c[1] as any);

beforeEach(() => {
  db = world(); jar.clear(); vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "test-key-test-key-test-key-test-key";
  process.env.NEWQUIP_ROLE_SWITCH_EMAILS = "shirnel@a, shirnel-owner@a";
});
afterEach(() => { delete process.env.NEWQUIP_ROLE_SWITCH_EMAILS; });

describe("who may switch", () => {
  it("René (Estimator only) has no switch and is refused if he calls the action; he never holds Rep or Manager", async () => {
    as("rene");
    expect(await resolveSwitchState(db as never, ORG, "u-rene")).toBeNull();
    expect((await switchTo("rene", "MANAGER")).ok).toBe(false);
    expect((await switchTo("rene", "REP")).ok).toBe(false);
    expect(jar.size).toBe(0);
    const v = await viewer("rene");
    expect(v.roles).toEqual(["estimator"]);
  });
  it("a three-role user who is NOT on the allowlist is not switchable (their ordinary behaviour is unchanged)", async () => {
    expect((await switchTo("intruder", "MANAGER")).ok).toBe(false);
    expect(jar.size).toBe(0);
    expect((await viewer("intruder")).roles.sort()).toEqual(["estimator", "manager", "rep"]); // as before this feature
  });
  it("with the allowlist unset NOBODY can switch, not even Shirnel (production default keeps separation of duties)", async () => {
    delete process.env.NEWQUIP_ROLE_SWITCH_EMAILS;
    expect((await switchTo("shirnel", "ESTIMATOR")).ok).toBe(false);
    expect(await resolveSwitchState(db as never, ORG, "u-sh")).toBeNull();
  });
  it("Shirnel may choose only a role she holds; a made-up or unheld role is refused and nothing is set", async () => {
    expect((await switchTo("shirnel", "ADMINISTRATOR")).ok).toBe(false);
    expect((await switchTo("shirnel", "owner")).ok).toBe(false);
    expect(jar.size).toBe(0);
    db.rows("org_functional_roles").splice(db.rows("org_functional_roles").findIndex((r: any) => r.user_id === "u-sh" && r.role === "MANAGER"), 1);
    expect((await switchTo("shirnel", "MANAGER")).ok).toBe(false); // she no longer holds it
    expect((await switchTo("shirnel", "ESTIMATOR")).ok).toBe(true);
  });
});

describe("each active role enforces its own server-side permissions and visibility", () => {
  it("starts as Rep (least privilege): rep role only, NO cost visibility, even though she holds all three", async () => {
    const v = await viewer("shirnel");
    expect(v.roles).toEqual(["rep"]); expect(v.canViewCommercials).toBe(false);
  });
  it("Estimator mode: estimator only, costs visible. Manager mode: manager only, costs visible. Back to Rep: costs hidden again", async () => {
    expect((await switchTo("shirnel", "ESTIMATOR")).ok).toBe(true);
    let v = await viewer("shirnel"); expect(v.roles).toEqual(["estimator"]); expect(v.canViewCommercials).toBe(true);
    expect((await switchTo("shirnel", "MANAGER")).ok).toBe(true);
    v = await viewer("shirnel"); expect(v.roles).toEqual(["manager"]); expect(v.canViewCommercials).toBe(true);
    expect((await switchTo("shirnel", "REP")).ok).toBe(true);
    v = await viewer("shirnel"); expect(v.roles).toEqual(["rep"]); expect(v.canViewCommercials).toBe(false);
  });
  it("an organisation OWNER/ADMIN who switches to Rep gets neither cost visibility nor Manager powers from the admin tier", async () => {
    expect((await switchTo("shirnelOwner", "REP")).ok).toBe(true);
    const v = await viewer("shirnelOwner");
    expect(v.roles).toEqual(["rep"]); expect(v.canViewCommercials).toBe(false);
    expect((await switchTo("shirnelOwner", "MANAGER")).ok).toBe(true);
    expect((await viewer("shirnelOwner")).roles).toEqual(["manager"]);
  });
  it("Rep stage follows the active role: acting as Estimator she cannot submit as Rep; acting as Rep she can", async () => {
    seedQuote("REP_DRAFT");
    await switchTo("shirnel", "ESTIMATOR"); as("shirnel");
    let r = await actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT);
    expect(r.error).toBeTruthy(); expect(quote().state).toBe("REP_DRAFT");
    await switchTo("shirnel", "REP"); as("shirnel");
    r = await actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT);
    expect(r.error).toBeUndefined(); expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
  it("sign-off and approval follow the active role: only Estimator mode signs off, only Manager mode approves", async () => {
    seedQuote("ESTIMATOR_REVIEW");                                                           // handed off by someone else (rep@a)
    for (const role of ["REP", "MANAGER"]) {
      await switchTo("shirnel", role); as("shirnel");
      const r = await actions.signOffGrowerQuoteAction("q1");
      expect(r.error).toBeTruthy(); expect(quote().estimator_signoff_hash).toBeNull();
    }
    await switchTo("shirnel", "ESTIMATOR"); as("shirnel");
    expect((await actions.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(quote().estimator_signoff_hash).toBeTruthy();
    expect((await actions.approveGrowerQuoteAction("q1")).error).toBeTruthy();               // Estimator mode may not approve
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    await switchTo("shirnel", "REP"); as("shirnel");
    expect((await actions.approveGrowerQuoteAction("q1")).error).toBeTruthy();               // nor Rep mode
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
  it("separation of duties is NOT weakened: as Manager she may approve what she did not originate, but not a submission she prepared as Rep", async () => {
    // (a) someone else prepared and signed off: Manager mode approves
    seedQuote("ESTIMATOR_REVIEW");
    as("rene"); expect((await actions.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    await switchTo("shirnel", "MANAGER"); as("shirnel");
    const ok = await actions.approveGrowerQuoteAction("q1");
    expect(ok.error).toBeUndefined(); expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    expect(quote().approved_by_email).toBe("shirnel@a");
    // (b) she submitted it herself as Rep: the existing preparer rule refuses her at the later stages even in the right role
    db = world(); jar.clear(); seedQuote("REP_DRAFT");
    await switchTo("shirnel", "REP"); as("shirnel");
    expect((await actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT)).error).toBeUndefined();
    await switchTo("shirnel", "ESTIMATOR"); as("shirnel");
    const refused = await actions.signOffGrowerQuoteAction("q1");
    expect(refused.error).toMatch(/prepared or originated/); expect(quote().estimator_signoff_hash).toBeNull();
  });
});

describe("the choice cannot be forged, replayed or widened", () => {
  it("a record signed for another user, another organisation or a role she does not hold is ignored (she stays Rep)", async () => {
    process.env.ENCRYPTION_KEY = "test-key-test-key-test-key-test-key";
    for (const t of [signActiveRole({ user: "u-mgr", org: ORG, role: "MANAGER" }), signActiveRole({ user: "u-sh", org: "other-org", role: "MANAGER" }), "garbage.value"]) {
      jar.set(ACTIVE_ROLE_COOKIE, t);
      const v = await viewer("shirnel"); expect(v.roles).toEqual(["rep"]);
    }
    db.rows("org_functional_roles").splice(db.rows("org_functional_roles").findIndex((r: any) => r.user_id === "u-sh" && r.role === "MANAGER"), 1);
    jar.set(ACTIVE_ROLE_COOKIE, signActiveRole({ user: "u-sh", org: ORG, role: "MANAGER" }));       // validly signed, but no longer held
    expect((await viewer("shirnel")).roles).toEqual(["rep"]);
  });
  it("a signed selection never widens someone who is not eligible (René with a valid Manager record is still Estimator only)", async () => {
    jar.set(ACTIVE_ROLE_COOKIE, signActiveRole({ user: "u-rene", org: ORG, role: "MANAGER" }));
    expect((await viewer("rene")).roles).toEqual(["estimator"]);
  });
});

describe("audit: every action records the REAL identity and the effective role", () => {
  it("a switch and a sign-off are logged under Shirnel's own email with the role she acted as", async () => {
    await switchTo("shirnel", "ESTIMATOR");
    let entry = auditCalls().find((c) => c.action === "newquip.role_switched");
    expect(entry.actor).toEqual({ userId: "u-sh", email: "shirnel@a" });
    expect(entry.detail).toMatchObject({ from: "REP", to: "ESTIMATOR", effectiveRole: "ESTIMATOR" });
    seedQuote("ESTIMATOR_REVIEW"); as("shirnel");
    const r = await actions.signOffGrowerQuoteAction("q1");
    expect(r.error).toBeUndefined();
    entry = auditCalls().filter((c) => c.action !== "newquip.role_switched").pop();
    expect(entry.actor).toEqual({ userId: "u-sh", email: "shirnel@a" });
    expect(entry.detail.effectiveRole).toBe("ESTIMATOR");
  });
  it("people who cannot switch get no effectiveRole field (their audit records are unchanged)", async () => {
    seedQuote("ESTIMATOR_REVIEW"); as("rene");
    expect((await actions.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    const entry = auditCalls().pop();
    expect(entry.detail).not.toHaveProperty("effectiveRole");
  });
});
