import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { resolveActing } from "@/lib/demo-mode/context";
import { resolveRoles, canSeeCosts } from "@/lib/approvals/role-store";
import { logActivity } from "@/lib/activity-log";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { findCostKey } from "@/lib/newquip-assignments/rep-view";

// The REAL Rep-boundary and assignment-management server actions over an in-memory database. Only the session, roles and the audit log are replaced.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn(async () => ({ orgId: "org-a" })) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn(async () => false) }));
vi.mock("@/lib/demo-mode/context", async (orig) => ({ ...(await orig<typeof import("@/lib/demo-mode/context")>()), resolveActing: vi.fn() }));
import * as rep from "../actions";
import * as manage from "../assignment-actions";

const SENTINEL = 987654.321;
const C1 = "11111111-1111-4111-8111-111111111111"; const C2 = "22222222-2222-4222-8222-222222222222";
type Role = "REP" | "ESTIMATOR" | "MANAGER";
/** Everyone who exists in the organisation, with the roles the (mocked) role resolution gives them. */
const people: Record<string, { email: string; roles: Role[]; tier: "owner" | "admin" | "member" }> = {};
const who = (id: string, email: string, roles: Role[], tier: "owner" | "admin" | "member" = "member") => { people[id] = { email, roles, tier }; db.rows("org_members").push({ org_id: "org-a", user_id: id, role: tier }); };

/** Sign in as `id`. `admin` makes requireOrgAdmin succeed (organisation owner/admin tier). */
const as = (id: string, opts: { admin?: boolean; seeCost?: boolean } = {}) => {
  const p = people[id];
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org-a", userId: id, email: p.email } as never);
  vi.mocked(resolveActing).mockResolvedValue({ orgId: "org-a", userId: id, email: p.email, tier: null, demo: null } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!opts.admin) throw new Error("no"); return undefined as never; });
  vi.mocked(canSeeCosts).mockResolvedValue(!!opts.seeCost);
};
const quote = (id: string, customer: string | null, o: { org?: string; creator?: string } = {}) => {
  const draft = readyDraft();
  (draft.estimator as unknown as Record<string, unknown>).costOverrides = { feeder: { unitCostExVat: SENTINEL, reason: "negotiated", by: "e@nq.test", at: "t" } };
  (draft.estimator as unknown as Record<string, unknown>).physicalCosts = { SKU1: { unitCostCents: Math.round(SENTINEL * 100) } };
  db.rows("newquip_quotes").push({ id, org_id: o.org ?? "org-a", quote_ref: `NQ-${id}`, revision: 1, customer_name: "Farm", site_name: "Site", quote_type: "project", state: "REP_DRAFT", draft, contract_cents: null, project_id: null, created_by_email: o.creator ?? "creator@nq.test", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", accepted_baseline: null });
  if (customer) db.rows("newquip_quote_customers").push({ id: `s-${id}`, org_id: o.org ?? "org-a", quote_id: id, seq: 1, cin7_customer_id: customer, snapshot: {}, snapshot_hash: "h" });
};
const assignAs = async (manager: string, customer: string, rep: string) => { as(manager, { admin: true }); const r = await manage.assignRepToCustomerAction({ cin7CustomerId: customer, customerName: "Farm", repUserId: rep }); expect(r.ok, r.error).toBe(true); return r.data!.assignment; };

beforeEach(() => {
  db = new FakeDb(); db.assignmentsApplied = true; db.deliveryApplied = true; vi.mocked(logActivity).mockClear();
  for (const k of Object.keys(people)) delete people[k];
  (db as unknown as { auth: unknown }).auth = { admin: { getUserById: async (id: string) => ({ data: { user: people[id] ? { email: people[id].email } : null } }) } };
  vi.mocked(resolveRoles).mockImplementation(async (_db, _org, userId) => new Set(people[userId as string]?.roles ?? []) as never);
  who("mgr", "mgr@nq.test", ["REP", "ESTIMATOR", "MANAGER"], "admin");
  who("repA", "a@nq.test", ["REP"]); who("repB", "b@nq.test", ["REP"]); who("est", "est@nq.test", ["ESTIMATOR"]);
  quote("q1", C1, { creator: "someone.else@nq.test" }); quote("q2", C2, { creator: "a@nq.test" });
});

describe("the Rep boundary: assignment-scoped, cost-free, read-only", () => {
  it("a Rep reads a quotation of an assigned customer even though someone else created it, with no cost anywhere", async () => {
    await assignAs("mgr", C1, "repA"); as("repA");
    const r = await rep.getMyQuoteAction("q1");
    expect(r.ok, r.error).toBe(true);
    const text = JSON.stringify(r.data);
    expect(findCostKey(r.data)).toBeNull(); expect(text).not.toContain(String(SENTINEL)); expect(text).not.toContain("costOverrides"); expect(text).not.toContain("physicalCosts");
  });
  it("an unassigned customer, another Rep's customer, a quotation they CREATED for an unassigned customer, an unknown id and another organisation's quotation all give the SAME generic denial", async () => {
    quote("other-org", C1, { org: "org-b" });
    await assignAs("mgr", C1, "repA"); as("repA");
    const denials = await Promise.all(["q2", "unknown", "other-org"].map((id) => rep.getMyQuoteAction(id)));
    for (const d of denials) { expect(d.ok).toBe(false); expect(d.data).toBeUndefined(); expect(d.error).toBe("Quote not found."); }
    as("repB"); const b = await rep.getMyQuoteAction("q1"); expect(b).toMatchObject({ ok: false, error: "Quote not found." });
  });
  it("lists contain only the Rep's assigned customers and their quotations (not the Rep's own quotation for an unassigned customer)", async () => {
    await assignAs("mgr", C1, "repA"); as("repA");
    expect((await rep.listMyCustomersAction()).data!.map((c) => c.cin7CustomerId)).toEqual([C1]);
    expect((await rep.listMyQuotesAction()).data!.map((q) => q.id)).toEqual(["q1"]);
    expect((await rep.getMyCustomerHistoryAction(C1)).data!.map((q) => q.id)).toEqual(["q1"]);
    expect(await rep.getMyCustomerHistoryAction(C2)).toMatchObject({ ok: false, error: "Quote not found." });
  });
  it("revocation is immediate: the very next call after ending the assignment is denied", async () => {
    const a = await assignAs("mgr", C1, "repA"); as("repA");
    expect((await rep.getMyQuoteAction("q1")).ok).toBe(true);
    as("mgr", { admin: true }); expect((await manage.endRepAssignmentAction(a.id, "customer left the Rep")).ok).toBe(true);
    as("repA");
    expect(await rep.getMyQuoteAction("q1")).toMatchObject({ ok: false, error: "Quote not found." });
    expect((await rep.listMyQuotesAction()).data).toEqual([]); expect((await rep.listMyCustomersAction()).data).toEqual([]);
  });
  it("reassignment is immediate for both Reps", async () => {
    await assignAs("mgr", C1, "repA"); as("mgr", { admin: true });
    expect((await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", reason: "territory change" })).ok).toBe(true);
    as("repA"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(false);
    as("repB"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(true);
  });
  it("two Reps on one customer both see it", async () => {
    await assignAs("mgr", C1, "repA"); await assignAs("mgr", C1, "repB");
    as("repA"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(true); as("repB"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(true);
  });
  it("an administrator who is also a Rep and may see costs elsewhere STILL gets a cost-free Rep response, and still needs an assignment", async () => {
    as("mgr", { admin: true, seeCost: true });
    expect(await rep.getMyQuoteAction("q1")).toMatchObject({ ok: false, error: "Quote not found." });   // admins are not exempt from assignment here
    await assignAs("mgr", C1, "mgr"); as("mgr", { admin: true, seeCost: true });
    const r = await rep.getMyQuoteAction("q1");
    expect(r.ok, r.error).toBe(true); expect(findCostKey(r.data)).toBeNull(); expect(JSON.stringify(r.data)).not.toContain(String(SENTINEL));
  });
  it("a person without the Rep role cannot use the boundary at all", async () => {
    as("est"); expect(await rep.listMyQuotesAction()).toMatchObject({ ok: false, error: expect.stringMatching(/Only a Rep/) });
    expect(await rep.getMyQuoteAction("q1")).toMatchObject({ ok: false });
  });
  it("before migration 0118 the boundary is simply unavailable: no data, nothing org-wide leaks", async () => {
    db.assignmentsApplied = false; as("repA");
    const r = await rep.listMyQuotesAction(); expect(r.ok).toBe(false); expect(r.data).toBeUndefined(); expect(r.error).toMatch(/not available/);
    expect((await rep.getMyQuoteAction("q1")).data).toBeUndefined();
  });
  it("reading never writes: no insert, update or delete, no audit entry", async () => {
    await assignAs("mgr", C1, "repA"); db.writes.length = 0; vi.mocked(logActivity).mockClear(); as("repA");
    await rep.listMyCustomersAction(); await rep.listMyQuotesAction(); await rep.getMyQuoteAction("q1"); await rep.getMyCustomerHistoryAction(C1); await rep.getMyQuoteAction("q2");
    expect(db.writes).toEqual([]); expect(logActivity).not.toHaveBeenCalled();
  });
});

describe("managing assignments", () => {
  it("only a Manager or organisation administrator may assign; a Rep or Estimator is refused and nothing is written", async () => {
    for (const id of ["repA", "est"]) {
      as(id);
      expect(await manage.assignRepToCustomerAction({ cin7CustomerId: C1, customerName: "Farm", repUserId: "repB" })).toMatchObject({ ok: false, error: expect.stringMatching(/Only a Manager/) });
      expect(await manage.endRepAssignmentAction("x", "no good reason")).toMatchObject({ ok: false });
      expect(await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", reason: "no good reason" })).toMatchObject({ ok: false });
    }
    expect(db.rows("customer_rep_assignments")).toHaveLength(0);
  });
  it("validates the customer id, the name, membership of THIS organisation and the Rep role", async () => {
    as("mgr", { admin: true });
    const base = { cin7CustomerId: C1, customerName: "Farm", repUserId: "repA" };
    expect((await manage.assignRepToCustomerAction({ ...base, cin7CustomerId: "not-a-guid" })).error).toMatch(/Cin7 customer ID/);
    expect((await manage.assignRepToCustomerAction({ ...base, customerName: " " })).error).toMatch(/customer name/);
    expect((await manage.assignRepToCustomerAction({ ...base, repUserId: "stranger" })).error).toMatch(/not a member/);
    db.rows("org_members").push({ org_id: "org-b", user_id: "other-org-rep", role: "member" }); people["other-org-rep"] = { email: "x@y.test", roles: ["REP"], tier: "member" };
    expect((await manage.assignRepToCustomerAction({ ...base, repUserId: "other-org-rep" })).error).toMatch(/not a member/);
    expect((await manage.assignRepToCustomerAction({ ...base, repUserId: "est" })).error).toMatch(/does not hold the Rep role/);
    expect(db.rows("customer_rep_assignments")).toHaveLength(0);
  });
  it("assigning is audited once, idempotent, and writes ONLY to the assignment table (no role, quotation or Project change)", async () => {
    as("mgr", { admin: true }); db.writes.length = 0;
    const first = await manage.assignRepToCustomerAction({ cin7CustomerId: C1, customerName: "Farm", repUserId: "repA", reason: "territory" });
    const again = await manage.assignRepToCustomerAction({ cin7CustomerId: C1, customerName: "Farm", repUserId: "repA" });
    expect(first.data!.created).toBe(true); expect(again.data!.created).toBe(false);
    expect(logActivity).toHaveBeenCalledTimes(1); expect(vi.mocked(logActivity).mock.calls[0][1]).toMatchObject({ action: "newquip.rep_assigned" });
    expect([...new Set(db.writes.map((w) => w.table))]).toEqual(["customer_rep_assignments"]);
  });
  it("reassignment validates the NEW Rep before the old access is ended", async () => {
    const a = await assignAs("mgr", C1, "repA"); as("mgr", { admin: true });
    const r = await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "est", reason: "territory change" });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/does not hold the Rep role/);
    expect(db.rows("customer_rep_assignments").find((x) => x.id === a.id)!.ended_at ?? null).toBeNull();
    as("repA"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(true);
  });
  it("a reassignment that FAILS at the replacement leaves the previous Rep assigned and writes no audit entry; the same request succeeds once the cause is fixed", async () => {
    await assignAs("mgr", C1, "repA"); vi.mocked(logActivity).mockClear(); as("mgr", { admin: true });
    people.repB.email = "x@";                                                      // the replacement row will violate the table's CHECK
    const failed = await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", reason: "territory change" });
    expect(failed.ok).toBe(false); expect(logActivity).not.toHaveBeenCalled();
    as("repA"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(true);          // still hers
    as("repB"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(false);
    people.repB.email = "b@nq.test"; as("mgr", { admin: true });
    const ok = await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", reason: "territory change" });
    expect(ok.ok, ok.error).toBe(true); expect(ok.data!.created).toBe(true);
    expect(logActivity).toHaveBeenCalledTimes(1); expect(vi.mocked(logActivity).mock.calls[0][1]).toMatchObject({ action: "newquip.rep_reassigned", detail: { created: true } });
    as("repA"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(false); as("repB"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(true);
  });
  describe("post-commit audit is best-effort: a failing activity log never turns a committed change into a failure", () => {
    const failures: Array<[string, () => Promise<never>]> = [["rejected", () => Promise.reject(new Error("log table unavailable"))], ["thrown synchronously", () => { throw new Error("boom"); }]];
    for (const [label, boom] of failures) {
      it(`reassignment: ${label} audit write -> success returned, history intact with the exact successor link`, async () => {
        const a = await assignAs("mgr", C1, "repA"); vi.mocked(logActivity).mockImplementation(boom as never); const spy = vi.spyOn(console, "error").mockImplementation(() => {}); as("mgr", { admin: true });
        const r = await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", reason: "territory change" });
        expect(r.ok, r.error).toBe(true); expect(r.data!.created).toBe(true);
        const rows = db.rows("customer_rep_assignments");
        expect(rows.find((x) => x.id === a.id)).toMatchObject({ ended_by_email: "mgr@nq.test", end_reason: "territory change", replaced_by_assignment_id: r.data!.assigned.id });
        expect(rows).toHaveLength(2); as("repA"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(false); as("repB"); expect((await rep.getMyQuoteAction("q1")).ok).toBe(true);
        expect(spy).toHaveBeenCalled(); expect(String(spy.mock.calls[0][0])).toContain("newquip.rep_reassigned"); expect(JSON.stringify(spy.mock.calls)).not.toContain("territory change");
        spy.mockRestore(); vi.mocked(logActivity).mockImplementation(() => Promise.resolve());
      });
      it(`assign and end: ${label} audit write -> both still succeed and persist`, async () => {
        vi.mocked(logActivity).mockImplementation(boom as never); const spy = vi.spyOn(console, "error").mockImplementation(() => {}); as("mgr", { admin: true });
        const assigned = await manage.assignRepToCustomerAction({ cin7CustomerId: C1, customerName: "Farm", repUserId: "repA", reason: "territory" });
        expect(assigned.ok, assigned.error).toBe(true); expect(db.rows("customer_rep_assignments")).toHaveLength(1);
        const ended = await manage.endRepAssignmentAction(assigned.data!.assignment.id, "customer left the Rep");
        expect(ended.ok, ended.error).toBe(true); expect(db.rows("customer_rep_assignments")[0].ended_at).toBeTruthy();
        spy.mockRestore(); vi.mocked(logActivity).mockImplementation(() => Promise.resolve());
      });
    }
    it("a genuine DATABASE failure is NOT suppressed (and nothing is audited), nor is an authorisation error", async () => {
      await assignAs("mgr", C1, "repA"); vi.mocked(logActivity).mockClear(); as("mgr", { admin: true });
      const dbFail = await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repB", toRepUserId: "repA", reason: "not assigned to B" });
      expect(dbFail.ok).toBe(false); expect(dbFail.error).toMatch(/not currently assigned/);
      as("repA"); const denied = await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", reason: "I want it" });
      expect(denied.ok).toBe(false); expect(denied.error).toMatch(/Only a Manager or administrator/);
      expect(logActivity).not.toHaveBeenCalled();
    });
  });
  it("an unauthorised actor cannot reassign: the assignment stays exactly as it was", async () => {
    await assignAs("mgr", C1, "repA"); const before = JSON.stringify(db.rows("customer_rep_assignments"));
    for (const id of ["repA", "repB", "est"]) { as(id); expect((await manage.reassignCustomerAction({ cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", reason: "I want it" })).ok).toBe(false); }
    expect(JSON.stringify(db.rows("customer_rep_assignments"))).toBe(before);
  });
  it("ending and reassigning are audited with the reason, and history is preserved", async () => {
    const a = await assignAs("mgr", C1, "repA"); vi.mocked(logActivity).mockClear(); as("mgr", { admin: true });
    await manage.endRepAssignmentAction(a.id, "customer left the Rep");
    expect(vi.mocked(logActivity).mock.calls[0][1]).toMatchObject({ action: "newquip.rep_assignment_ended" });
    expect((await manage.listCustomerAssignmentsAction(C1)).data![0]).toMatchObject({ end_reason: "customer left the Rep", ended_by_email: "mgr@nq.test" });
    expect(db.rows("customer_rep_assignments")).toHaveLength(1);
  });
});
