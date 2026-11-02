// Variation billing scopes are internal: ordinary users cannot open or operate them; an org owner/admin can; the parent stays visible.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { goldenFixtureBaseline } from "@/lib/projects/baseline";
import { createProjectFromBaseline } from "@/lib/projects/project-store";
import { raiseVariation, approveVariation } from "@/lib/projects/variation-store";
import { createVariationBillingProject } from "@/lib/projects/variation-billing-store";
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
