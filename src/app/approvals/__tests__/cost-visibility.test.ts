import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { resolveActing } from "@/lib/demo-mode/context";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";

// The REAL approval-detail action with only the session mocked: who receives internal cost and margin in the returned DATA (not merely what the UI hides).
// Who may do what is decided on the server from the roles in the database, never from what the browser sends.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/projects/newquip-gate", () => ({ assertNewquipOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/demo-mode/context", async (orig) => ({ ...(await orig<typeof import("@/lib/demo-mode/context")>()), resolveActing: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as approvals from "../actions";
import * as growerActions from "@/app/newquip-grower/actions";

const ORG = "org-nq";
const EMAILS: Record<string, string> = { "u-rep": "rep@a", "u-est": "est@a", "u-mgr": "mgr@a", "u-adm": "adm@a", "u-buyer": "buyer@a", "u-plain": "plain@a", "u-adm2": "adm2@a", "u-mgr2": "mgr2@a" };
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const total = Math.round(evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true }).budget!.totals.subtotalExTax * 100);

function as(userId: string, admin: boolean) {
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId, email: EMAILS[userId] } as never);
  vi.mocked(resolveActing).mockResolvedValue({ orgId: ORG, userId, email: EMAILS[userId], tier: null, demo: null } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("not admin"); return undefined as never; });
}

beforeEach(() => {
  db = new FakeDb();
  seedGoldenCatalogue(db as never, ORG); db.approvalsApplied = true; db.rolesApplied = true; installStaged(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push({ org_id: ORG, user_id: "u-rep", role: "member" }, { org_id: ORG, user_id: "u-est", role: "member" }, { org_id: ORG, user_id: "u-mgr", role: "admin" }, { org_id: ORG, user_id: "u-adm", role: "admin" }, { org_id: ORG, user_id: "u-adm2", role: "member" }, { org_id: ORG, user_id: "u-mgr2", role: "member" });
  const grant = (u: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${u}-${role}`, org_id: ORG, user_id: u, user_email: EMAILS[u], role, assigned_by_email: "adm@a", assigned_at: "t" });
  grant("u-rep", "REP"); grant("u-est", "ESTIMATOR"); grant("u-mgr", "MANAGER"); grant("u-adm", "ADMINISTRATOR"); grant("u-adm2", "ADMINISTRATOR"); grant("u-mgr2", "MANAGER");
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft, draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});

describe("approval detail: internal cost and margin go only to an organisation owner/admin or a Manager", () => {
  const COST = /Estimated cost|Gross profit|Margin/i;
  async function pendingManagerRequest(): Promise<string> {
    as("u-est", false); expect((await growerActions.signOffGrowerQuoteAction("q1")).error).toBeUndefined();   // creates the Manager-stage approval request
    const req = (db.rows("approval_requests") as Array<{ id: string; status: string }>).find((r) => r.status === "PENDING"); expect(req).toBeTruthy();
    return req!.id;
  }
  const detailAs = async (user: string, admin: boolean, id: string) => { as(user, admin); const r = await approvals.getApprovalDetailAction(id); expect(r.ok, r.error).toBe(true); return r.data!; };

  it("an explicit Administrator who is NOT an organisation admin gets no cost or margin anywhere in the returned data", async () => {
    const id = await pendingManagerRequest();
    const d = await detailAs("u-adm2", false, id);
    expect(JSON.stringify(d.review)).not.toMatch(COST);
    expect(JSON.stringify(d.review.sections.map((s: { title: string }) => s.title))).not.toMatch(/internal/i);
  });
  it("an organisation admin and a Manager still receive it (by tier, by Manager role, and an admin who also holds Administrator)", async () => {
    const id = await pendingManagerRequest();
    for (const [u, admin] of [["u-mgr", true], ["u-adm", true], ["u-mgr2", false]] as const) {
      const d = await detailAs(u, admin, id);
      expect(JSON.stringify(d.review), u).toMatch(COST);
    }
  });
  it("a salesperson gets none either (unchanged)", async () => {
    const id = await pendingManagerRequest(); expect(JSON.stringify((await detailAs("u-rep", false, id)).review)).not.toMatch(COST);
  });
});
