import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { DEMO_COOKIE, DEMO_OWNER_EMAIL } from "../config";

// The REAL server actions (demo switcher, quotation workflow, approvals dashboard, administration) over the in-memory database. Only the session
// (the one authenticated OWNER), the cookie jar and the cost-visible evaluation context are replaced.
let db: FakeDb;
const jar = new Map<string, string>();
let session: { userId: string; orgId: string; email: string | null } = { userId: "u-owner", orgId: "e1aea782-d095-47ad-90fb-4fa65c9bf855", email: DEMO_OWNER_EMAIL };
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined), set: (n: string, v: string) => { jar.set(n, v); }, delete: (n: string) => { jar.delete(n); } }) }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: async () => session }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: async () => undefined }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/projects/newquip-gate", () => ({ assertNewquipOrg: vi.fn() }));
vi.mock("@/lib/projects/latest-cost-adapter", () => ({ readLatestCostEntries: async () => ({}) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as demo from "@/app/demo-mode/actions";
import * as grower from "@/app/newquip-grower/actions";
import * as approvals from "@/app/approvals/actions";
import * as roleActions from "@/app/approvals/role-actions";
import * as costActions from "@/app/newquip-grower/cost-actions";
import { setActiveOrgAction } from "@/actions/active-org";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { requireModuleAccess } from "@/lib/authorization";
import { resolveActing } from "../context";
import { signDemoClaims } from "../token";
import { docHistory } from "@/lib/approvals/approval-store";

const NQ = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const U = { owner: "u-owner", rep: "u-rep", est: "u-est", mgr: "u-mgr" };
const EMAIL: Record<string, string> = { "u-owner": DEMO_OWNER_EMAIL, "u-rep": "rep@sparkconsulting.co.za", "u-est": "estimator@sparkconsulting.co.za", "u-mgr": "manager@sparkconsulting.co.za" };
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const total = Math.round(evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true }).budget!.totals.subtotalExTax * 100);
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const acts = () => (db.rows("activity_log") as Array<Record<string, any>>); // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  process.env.VERCEL_ENV = "preview"; process.env.NEWQUIP_DEMO_MODE_ENABLED = "true"; process.env.NEWQUIP_DEMO_OWNER_EMAIL = DEMO_OWNER_EMAIL; process.env.ENCRYPTION_KEY = "k".repeat(40);
  jar.clear(); session = { userId: U.owner, orgId: NQ, email: DEMO_OWNER_EMAIL };
  db = new FakeDb(); db.approvalsApplied = true; db.rolesApplied = true; installStaged(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAIL[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push({ org_id: NQ, user_id: U.owner, role: "owner" }, { org_id: NQ, user_id: U.rep, role: "member" }, { org_id: NQ, user_id: U.est, role: "member" }, { org_id: NQ, user_id: U.mgr, role: "member" });
  const grant = (u: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${u}-${role}`, org_id: NQ, user_id: u, user_email: EMAIL[u], role, assigned_by_email: DEMO_OWNER_EMAIL, assigned_at: "t" });
  grant(U.rep, "REP"); grant(U.est, "ESTIMATOR"); grant(U.mgr, "MANAGER");
  db.rows("approval_settings").push({ org_id: NQ, roles_enforced: true }); // strict: only the explicit roles count for the three test users
  db.rows("newquip_quotes").push({ id: "q1", org_id: NQ, quote_ref: "NQ-Q-0100", revision: 1, customer_name: "Demo Customer", site_name: "Farm", quote_type: "project", state: "REP_DRAFT", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null, created_by_email: EMAIL[U.rep], estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});
const as = async (slot: string) => { const r = await demo.selectDemoIdentityAction(slot); expect(r.error).toBeUndefined(); expect(r.ok).toBe(true); };

describe("the definition of done: the owner signs in once and demonstrates Rep -> Estimator -> Manager", () => {
  it("rep submits, estimator signs off, manager approves; the history shows the effective users and the real owner", async () => {
    await as("rep");
    expect((await grower.sendGrowerQuoteToEstimatorAction("q1", total, "Customer contact")).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", handoff_by_email: EMAIL[U.rep] }); // the REP, not the owner
    await as("estimator");
    expect((await grower.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(quote().estimator_signoff_by_email).toBe(EMAIL[U.est]);
    await as("manager");
    expect((await grower.approveGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "MANAGER_APPROVED_FINAL", approved_by_email: EMAIL[U.mgr] });

    const h = await docHistory(db as never, NQ, "QUOTE", "q1");
    const decided = h.filter((e) => ["SUBMITTED", "APPROVED"].includes(e.action));
    expect(decided.map((e) => `${e.stage}:${e.action}:${e.actor_email}`)).toEqual([
      `ESTIMATOR:SUBMITTED:${EMAIL[U.rep]}`, `ESTIMATOR:APPROVED:${EMAIL[U.est]}`, `MANAGER:SUBMITTED:${EMAIL[U.est]}`, `MANAGER:APPROVED:${EMAIL[U.mgr]}`,
    ]);
    // the immutable history marks every step as DEMO and names both identities; the owner is never recorded as the approver
    for (const e of h) { expect(e.actor_name).toMatch(/^DEMO · /); expect(e.actor_name).toContain(`impersonated by ${DEMO_OWNER_EMAIL}`); expect(e.actor_email).not.toBe(DEMO_OWNER_EMAIL); expect(new Date(e.created_at).toISOString()).toBe(e.created_at); }

    // the audit log: the REAL owner is the actor; the effective user, selected role, revision, action, reason and UTC time are in the detail
    const approve = acts().find((a) => a.action === "approvals.approve" && a.detail.stage === "MANAGER")!;
    expect(approve.actor_email).toBe(DEMO_OWNER_EMAIL);
    expect(approve.detail).toMatchObject({ demo: true, marker: "DEMO/IMPERSONATED", effectiveUser: EMAIL[U.mgr], selectedRole: "Manager", actualOwner: DEMO_OWNER_EMAIL, documentRevision: expect.any(Number), decisionAction: "APPROVE", docRef: "NQ-Q-0100" });
    expect(new Date(approve.detail.atUtc).toISOString()).toBe(approve.detail.atUtc);
    expect(acts().filter((a) => a.action.startsWith("newquip.demo_mode")).map((a) => a.action)).toEqual(["newquip.demo_mode_selected", "newquip.demo_mode_selected", "newquip.demo_mode_selected"]);
    // every NewQuip workflow audit row while impersonating names the real owner as the actor
    for (const a of acts().filter((x) => x.detail?.demo)) { expect(a.actor_email).toBe(DEMO_OWNER_EMAIL); expect(a.summary).toMatch(/^\[DEMO\]/); }
  });

  it("the approvals dashboard shows each identity its own queue, notifications and permissions (no cross-identity leakage)", async () => {
    await as("rep");
    await grower.sendGrowerQuoteToEstimatorAction("q1", total, "Customer contact");
    await as("estimator");
    const est = (await approvals.getApprovalsDashboardAction()).data!;
    expect(est.me).toBe(EMAIL[U.est]);
    expect(est.summary.awaitingMe).toBe(1); // the estimator-stage request is waiting for ME
    expect((await approvals.getMyNotificationsAction()).data!.notifications.map((n) => n.kind)).toEqual(["ESTIMATOR_ASSIGNED"]);
    await as("manager");
    const mgr = (await approvals.getApprovalsDashboardAction()).data!;
    expect(mgr.me).toBe(EMAIL[U.mgr]);
    expect(mgr.summary.awaitingMe).toBe(0); // nothing waits for the manager yet
    expect((await approvals.getMyNotificationsAction()).data!.notifications).toEqual([]);
    await as("rep");
    expect((await approvals.getApprovalsDashboardAction()).data!.me).toBe(EMAIL[U.rep]);
  });
});

describe("separation of duties and role checks use the EFFECTIVE identity", () => {
  it("the effective Rep cannot sign off or approve their own quotation even though the owner controls the session; the owner's own powers do not leak", async () => {
    await as("rep");
    await grower.sendGrowerQuoteToEstimatorAction("q1", total, "Customer contact");
    expect((await grower.signOffGrowerQuoteAction("q1")).error).toMatch(/estimator role|Requires/i);
    expect((await grower.approveGrowerQuoteAction("q1")).error).toMatch(/waiting for estimator review|manager/i);
    expect(quote().estimator_signoff_hash).toBeNull();
    // even a Rep who ALSO holds the Estimator role cannot sign off the handoff they originated
    db.rows("org_functional_roles").push({ id: "r-rep-est", org_id: NQ, user_id: U.rep, user_email: EMAIL[U.rep], role: "ESTIMATOR", assigned_by_email: "x", assigned_at: "t" });
    expect((await grower.signOffGrowerQuoteAction("q1")).error).toMatch(/cannot approve/);
    expect(quote().estimator_signoff_hash).toBeNull();
  });
  it("the effective Estimator cannot give final approval, and the effective Manager cannot sign off in the estimator's place", async () => {
    await as("rep"); await grower.sendGrowerQuoteToEstimatorAction("q1", total, "Customer contact");
    await as("manager");
    expect((await grower.signOffGrowerQuoteAction("q1")).error).toMatch(/estimator role|Requires/i);
    await as("estimator"); await grower.signOffGrowerQuoteAction("q1");
    expect((await grower.approveGrowerQuoteAction("q1")).error).toMatch(/manager|Requires|role/i);
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
  it("a manager returns to the estimator through the effective identities, and the estimator then re-signs", async () => {
    await as("rep"); await grower.sendGrowerQuoteToEstimatorAction("q1", total, "Customer contact");
    await as("estimator"); await grower.signOffGrowerQuoteAction("q1");
    await as("manager");
    expect((await grower.returnGrowerQuoteToEstimatorAction("q1", "Margin looks thin on the feeders")).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", estimator_signoff_hash: null });
    const ret = (await docHistory(db as never, NQ, "QUOTE", "q1")).find((e) => e.action === "RETURNED")!;
    expect(ret).toMatchObject({ actor_email: EMAIL[U.mgr], destination: "ESTIMATOR", reason: "Margin looks thin on the feeders" });
    expect(ret.actor_name).toMatch(/^DEMO · /);
  });
  it("an effective user gets no broader access than their own real permissions: a user outside the module's allowed list is refused", async () => {
    db.rows("org_members").find((m) => (m as { user_id: string }).user_id === U.rep)!.allowed_modules = ["/reports"];
    const r = await demo.selectDemoIdentityAction("rep");
    expect(r.ok).toBe(true); // selecting is allowed; USING a module the account may not use is not
    expect((await grower.getGrowerViewerAction()).error).toMatch(/does not have access/);
  });
});

describe("selection is owner-only, Preview-only, switch-gated and organisation-bound", () => {
  const refused = async (slot = "rep") => { const r = await demo.selectDemoIdentityAction(slot); expect(r.ok).toBe(false); expect(jar.has(DEMO_COOKIE)).toBe(false); return r.error; };
  it("Production refuses to issue a demo context", async () => { process.env.VERCEL_ENV = "production"; expect(await refused()).toMatch(/Preview/); });
  it("is OFF unless the explicit server-side switch is set", async () => { delete process.env.NEWQUIP_DEMO_MODE_ENABLED; expect(await refused()).toMatch(/switched off/); });
  it("only the exact owner account may select; the test users and everyone else are refused", async () => {
    for (const email of ["rep@sparkconsulting.co.za", "estimator@sparkconsulting.co.za", "manager@sparkconsulting.co.za", "anton@sparkconsulting.co.za"]) { session = { ...session, email }; expect(await refused()).toMatch(/owner account/); }
  });
  it("never works for another organisation", async () => { session = { ...session, orgId: "1a1a7fd8-0000-0000-0000-000000000000" }; expect(await refused()).toMatch(/NewQuip test organisation/); });
  it("accepts only a slot name: an email, user id, role or organisation supplied by the caller is refused", async () => {
    for (const bad of ["admin@sparkconsulting.co.za", U.mgr, "MANAGER", "superadmin", "../owner", ""]) expect(await refused(bad)).toMatch(/Choose Rep/);
  });
  it("refuses an allowlisted account that is not a member of the organisation", async () => {
    const i = db.rows("org_members").findIndex((m) => (m as { user_id: string }).user_id === U.est); db.rows("org_members").splice(i, 1);
    expect(await refused("estimator")).toMatch(/not a member/);
  });
});

describe("a live demo identity can use ONLY the scoped quotation / approval actions", () => {
  it("every administrative, role, cost, organisation and super-admin operation is refused, and the same operations work again after exit", async () => {
    await as("manager");
    const denied = /Demo Mode/;
    expect((await roleActions.assignRoleAction(U.rep, "MANAGER")).error).toMatch(denied);
    expect((await roleActions.setStrictRolesAction(false)).error).toMatch(denied);
    expect((await costActions.captureLatestCostsAction("q1")).error).toMatch(denied);
    expect((await setActiveOrgAction(NQ)).error).toMatch(denied);
    await expect(requireOrgAdmin("do anything")).rejects.toThrow(denied);
    await expect(requireSuperAdmin()).rejects.toThrow(denied);
    await expect(requireModuleAccess("/projects")).rejects.toThrow(denied);
    expect((await approvals.saveApprovalSettingsAction({ targetBusinessDays: 3, reminderEveryHours: 24, maxReminders: 3, escalationEmail: null })).error).toMatch(denied);
    expect((await approvals.sendTestEmailAction()).error).toMatch(denied);
    expect((await approvals.getEmailStatusAction()).error).toMatch(denied);
    expect((await approvals.retryEmailAction("n1")).error).toMatch(denied);
    expect((db.rows("org_functional_roles") as Array<{ role: string; user_id: string }>).filter((r) => r.user_id === U.rep && r.role === "MANAGER")).toHaveLength(0);
    await demo.exitDemoModeAction();
    expect((await roleActions.assignRoleAction(U.rep, "PROCUREMENT")).error).toBeUndefined(); // the owner's own admin power is back
    await expect(requireOrgAdmin("do anything")).resolves.toBeTruthy();
  });
  it("an effective Rep cannot reach the manager-only dashboard controls", async () => {
    await as("rep");
    const d = (await approvals.getApprovalsDashboardAction()).data!;
    expect(d.isManager).toBe(false);
    expect(d.failedEmails).toEqual([]);
  });
});

describe("the cost panel under Demo Mode explains itself", () => {
  it("while a test identity is active the cost read refuses with a message naming Demo Mode (shown in the panel), and works again as Owner", async () => {
    await as("manager");
    expect((await costActions.getQuoteCostEstimateAction("q1")).error).toMatch(/Demo Mode/);
    await as("owner");
    expect((await costActions.getQuoteCostEstimateAction("q1")).error).toBeUndefined();
  });
});

describe("switching, exiting, expiry, tampering and Production", () => {
  it("switching identities changes the effective user immediately and nothing persists between them", async () => {
    const roles: string[][] = []; const sees: boolean[] = [];
    for (const slot of ["rep", "estimator", "manager", "owner", "rep"]) { await as(slot); const v = (await grower.getGrowerViewerAction()).data!; roles.push(v.roles.slice().sort()); sees.push(v.canViewCommercials); }
    // cost and margin visibility follows each identity's OWN permission (a plain-member Rep sees none; the owner tier does)
    expect(sees).toEqual([false, true, true, true, false]);
    expect(roles[0]).toEqual(["rep"]);
    expect(roles[1]).toEqual(["estimator"]);
    expect(roles[2]).toEqual(["manager"]);
    expect(roles[3]).toEqual([]); // the real owner with strict roles ON and no explicit role holds ADMINISTRATOR only, which approves nothing by itself
    expect(roles[4]).toEqual(["rep"]);
  });
  it("Exit Demo Mode clears the context and restores the real owner; Owner is the absence of a context", async () => {
    await as("manager");
    expect(jar.has(DEMO_COOKIE)).toBe(true);
    expect((await demo.exitDemoModeAction()).ok).toBe(true);
    expect(jar.has(DEMO_COOKIE)).toBe(false);
    expect(await resolveActing({ userId: U.owner, orgId: NQ, email: DEMO_OWNER_EMAIL })).toMatchObject({ userId: U.owner, email: DEMO_OWNER_EMAIL, demo: null });
    await as("rep"); await as("owner");
    expect(jar.has(DEMO_COOKIE)).toBe(false);
  });
  it("a context stops working the moment Production or the switch applies, even with a validly signed cookie; unrelated operations still deny", async () => {
    await as("manager");
    process.env.VERCEL_ENV = "production";
    expect((await grower.getGrowerViewerAction()).error).toMatch(/Demo Mode is not valid here/);
    expect((await approvals.getApprovalsDashboardAction()).error).toMatch(/Demo Mode is not valid here/);
    await expect(requireOrgAdmin("x")).rejects.toThrow(/Demo Mode/);
    process.env.VERCEL_ENV = "preview"; delete process.env.NEWQUIP_DEMO_MODE_ENABLED;
    expect((await grower.getGrowerViewerAction()).error).toMatch(/Demo Mode is not valid here/);
  });
  it("a cookie signed for a different sign-in or organisation is never honoured", async () => {
    jar.set(DEMO_COOKIE, signDemoClaims({ owner: "u-someone-else", org: NQ, slot: "manager" }).token);
    expect((await grower.getGrowerViewerAction()).error).toMatch(/different sign-in/);
    jar.set(DEMO_COOKIE, signDemoClaims({ owner: U.owner, org: "1a1a7fd8-0000-0000-0000-000000000000", slot: "manager" }).token);
    expect((await grower.getGrowerViewerAction()).error).toMatch(/different sign-in/);
  });
  it("another signed-in user (not the owner) holding a stolen valid cookie gets nothing: the owner binding and the gate both fail", async () => {
    const stolen = signDemoClaims({ owner: U.owner, org: NQ, slot: "manager" }).token;
    jar.set(DEMO_COOKIE, stolen);
    session = { userId: U.mgr, orgId: NQ, email: EMAIL[U.mgr] };
    expect((await grower.getGrowerViewerAction()).error).toMatch(/Demo Mode is not valid here/);
  });
  it("a forged, tampered or expired cookie is ignored: the owner acts as themselves and no demo marker is written", async () => {
    jar.set(DEMO_COOKIE, "forged.value");
    expect(await resolveActing({ userId: U.owner, orgId: NQ, email: DEMO_OWNER_EMAIL })).toMatchObject({ demo: null, userId: U.owner });
    const old = signDemoClaims({ owner: U.owner, org: NQ, slot: "manager" }, Date.now() - 3 * 3600_000).token;
    jar.set(DEMO_COOKIE, old);
    expect((await resolveActing({ userId: U.owner, orgId: NQ, email: DEMO_OWNER_EMAIL })).demo).toBeNull();
    await expect(requireOrgAdmin("x")).resolves.toBeTruthy(); // no live context: the ordinary guard applies
  });
});
