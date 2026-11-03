// Variation billing scopes are internal: ordinary users cannot open or operate them; an org owner/admin can; the parent stays visible.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { goldenFixtureBaseline } from "@/lib/projects/baseline";
import { createProjectFromBaseline } from "@/lib/projects/project-store";
import { raiseVariation, approveVariation } from "@/lib/projects/variation-store";
import { createVariationBillingProject, loadConsolidatedProject } from "@/lib/projects/variation-billing-store";
import { loadProjectView } from "@/lib/projects/project-store";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import * as actions from "../actions";
import * as cin7Actions from "../cin7-actions";
import * as physicalActions from "../physical-actions";
import * as billingActions from "../variation-billing-actions";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
const REC = { saleId: "x", customerName: "c", location: "l", revenueAccount: "200", cin7TaxRule: "t", reason: "a reason that is long enough" };

const ORG = NEWQUIP_POC_ORG_IDS[0];
let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => db) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/cin7-adapter", () => ({ buildCin7Port: vi.fn(() => ({})), singleActiveInstanceId: vi.fn(() => Promise.resolve("inst")) }));

let parent: string; let scope: string;
const asMember = () => vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can do that."));
const asAdmin = () => vi.mocked(requireOrgAdmin).mockResolvedValue({} as never);

beforeEach(async () => {
  db = new FakeDb();
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u", email: "m@x" } as never);
  parent = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "n" });
  const v = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "V", description: "", amountCents: 48_000_000 });
  await approveVariation(db as never, ORG, "m@x", parent, v.variationId);
  scope = (await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId: parent, variationId: v.variationId })).billingProjectId;
});

describe("ordinary users", () => {
  beforeEach(() => { asMember(); });
  it("cannot open a billing scope: they are redirected to the parent, and no data is returned", async () => {
    const r = await actions.getProjectAction(scope);
    expect(r).toMatchObject({ ok: false, redirectTo: parent });
    expect(r.data).toBeUndefined();
  });
  it("still see the parent project", async () => {
    const r = await actions.getProjectAction(parent);
    expect(r.ok).toBe(true);
    expect(r.data?.project.id).toBe(parent);
  });
  it("cannot list billing scopes as projects", async () => {
    const r = await actions.listProjectsAction();
    expect(r.data?.map((v) => v.project.id)).toEqual([parent]);
  });
  it.each([
    ["recordProgress", () => actions.recordProgressAction(scope, "s", "10", null, "")],
    ["previewClaim", () => actions.previewClaimAction(scope)],
    ["createClaimDraft", () => actions.createClaimDraftAction(scope)],
    ["submitClaim", () => actions.submitClaimForApprovalAction(scope, "c")],
    ["cancelDraft", () => actions.cancelDraftClaimAction(scope, "c")],
    ["recalculateStale", () => actions.recalculateStaleDraftAction(scope, "c")],
    ["cin7 status", () => cin7Actions.getCin7PostingStatusAction(scope)],
    ["cin7 link", () => cin7Actions.recoverLinkCin7SaleAction(scope, REC)],
    ["cin7 post", () => cin7Actions.postClaimToCin7Action(scope, "c", "x")],
    ["cin7 reconcile", () => cin7Actions.reconcileClaimPostingAction(scope, "c")],
    ["sale creation status", () => cin7Actions.getCin7SaleCreationStatusAction(scope)],
    ["sale creation", () => cin7Actions.createCin7SaleAction(scope, { confirmation: "x", customerName: "c", location: "l", revenueAccount: "2", cin7TaxRule: "Standard Rate Sales" })],
    ["sale creation reconcile", () => cin7Actions.reconcileCin7SaleCreationAction(scope)],
    ["physical", () => physicalActions.getPhysicalStatusAction(scope)],
  ])("cannot operate a billing scope directly: %s", async (_n, run) => {
    const writes = db.writes.length;
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/internal billing scope/);
    expect(db.writes.length).toBe(writes);
  });
  it("see the variation billing summary through the parent, without internal management links or closure details", async () => {
    const r = await billingActions.getVariationBillingAction(parent);
    expect(r.ok).toBe(true);
    expect(r.data?.consolidated.scopes).toHaveLength(2);
    expect(r.data?.consolidated.closureBlockers).toEqual([]);
  });
});

describe("authorised internal operation (org owner/admin)", () => {
  beforeEach(() => { asAdmin(); });
  it("can open and read a billing scope", async () => {
    const r = await actions.getProjectAction(scope);
    expect(r.ok).toBe(true);
    expect(r.data?.project.id).toBe(scope);
    expect(r.redirectTo).toBeUndefined();
  });
  it("can run claim operations on it", async () => {
    expect((await actions.previewClaimAction(scope)).error ?? "").not.toMatch(/internal billing scope/);
    expect((await physicalActions.getPhysicalStatusAction(scope)).error ?? "").not.toMatch(/internal billing scope/);
  });
  it("sees why the parent cannot be closed yet", async () => {
    const r = await billingActions.getVariationBillingAction(parent);
    expect(r.data?.consolidated.closureBlockers.join(" ")).toMatch(/variation scope PRJ-NQ-Q-0001-V001 is still ACTIVE/);
  });
});

describe("opening commitments", () => {
  it("are refused on a billing scope even for an admin, with an explicit reason", async () => {
    asAdmin();
    const r = await actions.setOpeningCommitmentsAction(scope, [{ stageId: "x", rands: "1" }], "pre-billed");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot carry opening commitments/);
    expect(db.rows("project_opening_commitments")).toHaveLength(0);
  });
});

describe("Cin7 Sale number on the variation billing state (read only, org-scoped)", () => {
  beforeEach(() => { asMember(); });
  const link = (org: string, project: string, num: string | null) => db.rows("project_cin7_sale_links").push({ org_id: org, project_id: project, cin7_sale_id: `s-${project}`, cin7_sale_number: num });
  it("returns the stored number against the variation's own billing project, and nothing for the base project's Sale", async () => {
    link(ORG, scope, "SO-V1"); link(ORG, parent, "SO-BASE");
    const r = await billingActions.getVariationBillingAction(parent);
    const vid = Object.keys(r.data!.billingProjectByVariation)[0];
    expect(r.data!.saleNumberByVariation).toEqual({ [vid]: "SO-V1" });
    expect(r.data!.saleLookupFailed).toBe(false);
  });
  it("reports a link with no stored number as null (linked, number not recorded), and no link as absent", async () => {
    let r = await billingActions.getVariationBillingAction(parent);
    expect(r.data!.saleNumberByVariation).toEqual({});
    link(ORG, scope, null);
    r = await billingActions.getVariationBillingAction(parent);
    const vid = Object.keys(r.data!.billingProjectByVariation)[0];
    expect(r.data!.saleNumberByVariation).toEqual({ [vid]: null });
  });
  it("never returns another organisation's Sale for the same project id", async () => {
    link("other-org", scope, "SO-OTHER");
    const r = await billingActions.getVariationBillingAction(parent);
    expect(r.data!.saleNumberByVariation).toEqual({});
  });
  it("a failing Sale lookup does NOT fail the billing state: it is flagged, logged and no number is shown", async () => {
    const real = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (t: string) => { if (t === "project_cin7_sale_links") throw new Error("boom"); return real(t); };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await billingActions.getVariationBillingAction(parent);
    expect(r.ok).toBe(true);
    expect(r.data!.saleLookupFailed).toBe(true);
    expect(r.data!.saleNumberByVariation).toEqual({});
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("Cin7 reconciliation on the variation billing state (read only, org-scoped, own billing project only)", () => {
  beforeEach(() => { asMember(); });
  const post = (org: string, project: string, state: string, extra: Record<string, unknown> = {}) => db.rows("project_claim_cin7_postings").push({ org_id: org, project_id: project, claim_id: `c-${Math.random()}`, posting_state: state, requested_at: new Date().toISOString(), ...extra });
  const vidOf = async () => { const r = await billingActions.getVariationBillingAction(parent); return { r, vid: Object.keys(r.data!.billingProjectByVariation)[0] }; };
  it("counts the variation's own invoices by recorded state, separating created, reconciled and uncertain; a failed-no-write posting is not an invoice", async () => {
    for (const st of ["RECONCILED", "RECONCILED", "CREATED", "PENDING", "FAILED_UNCERTAIN", "FAILED_CONFIRMED_NO_WRITE"]) post(ORG, scope, st);
    const { r, vid } = await vidOf();
    expect(r.data!.reconciliationByVariation).toEqual({ [vid]: { invoices: 3, reconciled: 2, awaiting: 1, mismatched: 0, uncertain: 1, inProgress: 1, retryable: 1, postingExVatCents: 0 } });
    expect(r.data!.reconciliationLookupFailed).toBe(false);
  });
  it("a PENDING inside the in-flight window is 'in progress'; an old PENDING is uncertain; a CREATED with a recorded AMOUNT_MISMATCH is shown as a mismatch, not 'awaiting'", async () => {
    post(ORG, scope, "PENDING"); post(ORG, scope, "PENDING", { requested_at: new Date(Date.now() - 3_600_000).toISOString() }); post(ORG, scope, "PENDING", { requested_at: null });
    post(ORG, scope, "CREATED", { last_error_code: "AMOUNT_MISMATCH" }); post(ORG, scope, "CREATED");
    const { r, vid } = await vidOf();
    expect(r.data!.reconciliationByVariation[vid]).toEqual({ invoices: 2, reconciled: 0, awaiting: 1, mismatched: 1, uncertain: 2, inProgress: 1, retryable: 0, postingExVatCents: 0 });
  });
  it("reports zero counts (not an absent key) when the billing project has no postings", async () => {
    const { r, vid } = await vidOf();
    expect(r.data!.reconciliationByVariation).toEqual({ [vid]: { invoices: 0, reconciled: 0, awaiting: 0, mismatched: 0, uncertain: 0, inProgress: 0, retryable: 0, postingExVatCents: 0 } });
  });
  it("BASE/VARIATION isolation: the original project's postings never count toward the variation, and another organisation's never appear", async () => {
    post(ORG, parent, "RECONCILED"); post("other-org", scope, "RECONCILED");
    const { r, vid } = await vidOf();
    expect(r.data!.reconciliationByVariation[vid].invoices).toBe(0);
  });
  it("ONE approved-variation amount: the Variations panel's scope contract equals the billing project's view contract the Overview uses, and the variation amount", async () => {
    const c = await loadConsolidatedProject(db as never, ORG, parent);
    const s = c!.scopes.find((x) => x.scope === "VARIATION")!;
    const v = await loadProjectView(db as never, ORG, scope);
    expect(v!.commercial.originalContractCents).toBe(s.contractCents);
    expect(c!.base.variations.find((x) => x.code === s.variationCode)!.amount_cents).toBe(s.contractCents);
  });
  it("a failing read does NOT fail the billing state or the Sale number: it is flagged and logged, and no status is invented", async () => {
    post(ORG, scope, "RECONCILED");
    const real = db.from.bind(db);
    // only the new batched read (.in on project_id) fails; the other readers of this table (the consolidated project) keep working
    const wrap = (o: object): object => new Proxy(o, { get: (target, k, recv) => {
      if (k === "in") return () => { throw new Error("boom"); };
      const v = Reflect.get(target, k, recv);
      if (k === "then") return typeof v === "function" ? v.bind(target) : v; // the builders are thenable at every step: awaiting must reach the real one
      return typeof v === "function" ? (...a: unknown[]) => { const r = v.apply(target, a); return r && typeof r === "object" ? wrap(r) : r; } : v;
    } });
    (db as unknown as { from: (t: string) => unknown }).from = (t: string) => (t === "project_claim_cin7_postings" ? wrap(real(t) as object) : real(t));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await billingActions.getVariationBillingAction(parent);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.data!.reconciliationLookupFailed).toBe(true);
    expect(r.data!.reconciliationByVariation).toEqual({});
    expect(r.data!.saleLookupFailed).toBe(false);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
  it("makes no Cin7 call and writes nothing", async () => {
    post(ORG, scope, "CREATED");
    const before = JSON.stringify(db.rows("project_claim_cin7_postings"));
    await billingActions.getVariationBillingAction(parent);
    expect(JSON.stringify(db.rows("project_claim_cin7_postings"))).toBe(before);
  });
});
