import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";

// The REAL server actions (roles administration, and the quotation actions that route through the staged engine) with only the session mocked.
// Who may do what is decided on the server from the roles in the database, never from what the browser sends.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/projects/newquip-gate", () => ({ assertNewquipOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as roleActions from "../role-actions";
import * as growerActions from "@/app/newquip-grower/actions";

const ORG = "org-nq";
const EMAILS: Record<string, string> = { "u-rep": "rep@a", "u-est": "est@a", "u-mgr": "mgr@a", "u-adm": "adm@a", "u-buyer": "buyer@a", "u-plain": "plain@a" };
const draft = applyDemoDefaults(emptyDraft()).draft;
const total = Math.round(evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true }).budget!.totals.subtotalExTax * 100);

function as(userId: string, admin: boolean) {
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId, email: EMAILS[userId] } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("not admin"); return undefined as never; });
}

beforeEach(() => {
  db = new FakeDb(); db.approvalsApplied = true; db.rolesApplied = true; installStaged(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push({ org_id: ORG, user_id: "u-rep", role: "member" }, { org_id: ORG, user_id: "u-est", role: "member" }, { org_id: ORG, user_id: "u-mgr", role: "admin" }, { org_id: ORG, user_id: "u-adm", role: "admin" });
  const grant = (u: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${u}-${role}`, org_id: ORG, user_id: u, user_email: EMAILS[u], role, assigned_by_email: "adm@a", assigned_at: "t" });
  grant("u-rep", "REP"); grant("u-est", "ESTIMATOR"); grant("u-mgr", "MANAGER"); grant("u-adm", "ADMINISTRATOR");
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft, draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});

describe("roles administration actions", () => {
  it("a salesperson, estimator or manager cannot change roles, policies or strict roles; an administrator can", async () => {
    for (const [u, admin] of [["u-rep", false], ["u-est", false], ["u-mgr", false]] as const) {
      as(u, admin);
      expect((await roleActions.assignRoleAction("u-rep", "MANAGER")).error).toMatch(/Only an administrator/);
      expect((await roleActions.removeRoleAction("u-mgr", "MANAGER")).error).toMatch(/Only an administrator/);
      expect((await roleActions.setStrictRolesAction(true)).error).toMatch(/Only an administrator/);
      expect((await roleActions.saveApprovalPolicyAction("CLAIM", [{ stage: "MANAGER", role: "MANAGER", approverEmail: null }])).error).toMatch(/Only an administrator/);
    }
    expect((db.rows("org_functional_roles") as Array<{ user_id: string; role: string }>).some((r) => r.user_id === "u-rep" && r.role === "MANAGER")).toBe(false);
    as("u-adm", false); // an explicit Administrator (no org-tier admin) may administer
    expect((await roleActions.assignRoleAction("u-rep", "PROCUREMENT")).ok).toBe(true);
    const strictRes = await roleActions.setStrictRolesAction(true); expect(strictRes.error).toBeUndefined();
    expect((await roleActions.getRolesAdminAction()).data!.strict).toBe(true);
  });
  it("an unknown role is refused, and strict roles cannot be switched on while nobody holds the manager role", async () => {
    as("u-adm", true);
    expect((await roleActions.assignRoleAction("u-rep", "SUPERUSER")).error).toMatch(/Unknown role/);
    await roleActions.removeRoleAction("u-mgr", "MANAGER");
    expect((await roleActions.setStrictRolesAction(true)).error).toMatch(/Manager role/);
  });
  it("everyone can read the routing, but only an administrator sees the role history", async () => {
    as("u-rep", false);
    const v = (await roleActions.getRolesAdminAction()).data!;
    expect(v.canAdminister).toBe(false);
    expect(v.history).toEqual([]);
    expect(v.users.map((u) => u.email)).toEqual(["adm@a", "est@a", "mgr@a", "rep@a"]);
  });
});

describe("who may see estimated costs and margins", () => {
  it("an explicit Estimator or Manager (even a plain org member) can; a salesperson, a buyer, a bare Administrator and a member with no explicit role cannot", async () => {
    db.rows("org_members").push({ org_id: ORG, user_id: "u-buyer", role: "member" }, { org_id: ORG, user_id: "u-plain", role: "member" });
    db.rows("org_functional_roles").push({ id: "r-buyer", org_id: ORG, user_id: "u-buyer", user_email: "buyer@a", role: "PROCUREMENT", assigned_by_email: "x", assigned_at: "t" });
    const sees = async (u: string, admin = false) => { as(u, admin); return (await growerActions.getGrowerViewerAction()).data!.canViewCommercials; };
    expect(await sees("u-est")).toBe(true);          // explicit Estimator, org member
    expect(await sees("u-mgr")).toBe(true);          // explicit Manager
    expect(await sees("u-adm", true)).toBe(true);    // organisation owner/admin
    expect(await sees("u-rep")).toBe(false);         // salesperson
    expect(await sees("u-buyer")).toBe(false);       // Procurement sees purchasing targets, never the margins
    expect(await sees("u-adm")).toBe(false);         // an explicit Administrator role alone is not cost access
    expect(await sees("u-plain")).toBe(false);       // the Phase H tier fallback (member = estimator) must NOT leak cost
  });
  it("before migration 0112 nothing changes: only owner/admin see cost, exactly as in Phase H", async () => {
    db.rolesApplied = false;
    const sees = async (u: string, admin = false) => { as(u, admin); return (await growerActions.getGrowerViewerAction()).data!.canViewCommercials; };
    expect(await sees("u-est")).toBe(false);
    expect(await sees("u-adm", true)).toBe(true);
  });
  it("the cost view is redacted for those who cannot see it, and an explicit estimator receives the cost-visible evaluation", async () => {
    as("u-rep", false);
    const hidden = (await growerActions.getGrowerQuoteAction("q1")).data!;
    expect(hidden.viewer.canViewCommercials).toBe(false);
    expect(JSON.stringify(hidden.quote)).not.toMatch(/physicalCosts|costOverrides|internalMargin/);
    as("u-est", false);
    expect((await growerActions.getGrowerQuoteAction("q1")).data!.viewer.canViewCommercials).toBe(true);
  });
});

describe("quotation actions through the staged engine", () => {
  it("the manager returns a signed-off quote to the estimator through the real action; a salesperson or estimator cannot", async () => {
    as("u-est", false);
    expect((await growerActions.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    expect((db.rows("newquip_quotes")[0] as { estimator_signoff_hash: string | null }).estimator_signoff_hash).toBe("h1");
    as("u-est", false);
    expect((await growerActions.returnGrowerQuoteToEstimatorAction("q1", "Margin too thin")).error).toMatch(/manager role/i);
    as("u-rep", false);
    expect((await growerActions.returnGrowerQuoteToEstimatorAction("q1", "Margin too thin")).error).toMatch(/manager role/i);
    as("u-mgr", true);
    const r = await growerActions.returnGrowerQuoteToEstimatorAction("q1", "Margin too thin");
    expect(r.error).toBeUndefined();
    expect(db.rows("newquip_quotes")[0]).toMatchObject({ state: "ESTIMATOR_REVIEW", estimator_signoff_hash: null, revision: 1 });
    // and the manager can no longer approve until the estimator signs off again
    expect((await growerActions.approveGrowerQuoteAction("q1")).error).toMatch(/waiting for estimator review/);
  });
  it("a manager cannot give final approval before the estimator has signed off, and approval after sign-off freezes the baseline", async () => {
    as("u-mgr", true);
    expect((await growerActions.approveGrowerQuoteAction("q1")).error).toMatch(/waiting for estimator review/);
    as("u-est", false); await growerActions.signOffGrowerQuoteAction("q1");
    as("u-mgr", true);
    expect((await growerActions.approveGrowerQuoteAction("q1")).error).toBeUndefined();
    expect((db.rows("newquip_quotes")[0] as { state: string }).state).toBe("MANAGER_APPROVED_FINAL");
  });
  it("without migration 0112 the return-to-estimator action explains the dependency instead of changing anything", async () => {
    db.rolesApplied = false;
    as("u-mgr", true);
    expect((await growerActions.returnGrowerQuoteToEstimatorAction("q1", "x y z")).error).toMatch(/migration/);
  });
});
