import { describe, expect, it, vi, beforeEach } from "vitest";
import * as actions from "../actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import * as store from "@/lib/projects/project-store";
import * as variationStore from "@/lib/projects/variation-store";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/projects/scope-access", async (orig) => ({ ...(await orig<typeof import("@/lib/projects/scope-access")>()), guardBillingScope: vi.fn(() => Promise.resolve()) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/project-store", () => ({
  approveClaim: vi.fn(), cancelDraftClaim: vi.fn(), createClaimDraft: vi.fn(() => Promise.resolve({ claimId: "c1", duplicate: false })),
  listProjectViews: vi.fn(() => Promise.resolve([])), loadProjectView: vi.fn(() => Promise.resolve(null)),
  previewClaim: vi.fn(), recalculateStaleDraft: vi.fn(), recordProgress: vi.fn(), setOpeningCommitments: vi.fn(), seedGoldenFixture: vi.fn(() => Promise.resolve("p1")), submitClaimForApproval: vi.fn(),
}));

vi.mock("@/lib/projects/variation-store", () => ({
  raiseVariation: vi.fn(() => Promise.resolve({ variationId: "v1", code: "V001" })), repriceVariation: vi.fn(), approveVariation: vi.fn(), rejectVariation: vi.fn(),
}));

const SESSION = { orgId: "org-session", userId: "u1", email: "u@x" };
const MODULE_DENIED = "You don't have access to this feature.";
const NOT_ADMIN = "Only an org owner or admin can do that.";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockResolvedValue(SESSION as never);
});

const ALL: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
  ["listProjectsAction", () => actions.listProjectsAction()],
  ["getViewerPermissionsAction", () => actions.getViewerPermissionsAction()],
  ["getProjectAction", () => actions.getProjectAction("p1")],
  ["seedGoldenProjectAction", () => actions.seedGoldenProjectAction()],
  ["recordProgressAction", () => actions.recordProgressAction("p1", "s1", "10", null, "")],
  ["previewClaimAction", () => actions.previewClaimAction("p1")],
  ["createClaimDraftAction", () => actions.createClaimDraftAction("p1")],
  ["submitClaimForApprovalAction", () => actions.submitClaimForApprovalAction("p1", "c1")],
  ["approveClaimAction", () => actions.approveClaimAction("p1", "c1")],
  ["cancelDraftClaimAction", () => actions.cancelDraftClaimAction("p1", "c1")],
  ["recalculateStaleDraftAction", () => actions.recalculateStaleDraftAction("p1", "c1")],
  ["setOpeningCommitmentsAction", () => actions.setOpeningCommitmentsAction("p1", [{ stageId: "s1", rands: "1000000" }], "r")],
  ["raiseVariationAction", () => actions.raiseVariationAction("p1", "V001 – Additional Ventilation", "", "480000")],
  ["repriceVariationAction", () => actions.repriceVariationAction("p1", "v1", "480000")],
  ["approveVariationAction", () => actions.approveVariationAction("p1", "v1")],
  ["rejectVariationAction", () => actions.rejectVariationAction("p1", "v1", "no")],
];
const storeFns = [...Object.values(store), ...Object.values(variationStore)].filter((f) => typeof f === "function") as unknown as Array<ReturnType<typeof vi.fn>>;

describe("every Projects action re-establishes module access first", () => {
  it.each(ALL)("%s: module denied -> error and NO store call", async (_name, run) => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.error).toBe(MODULE_DENIED);
    for (const f of storeFns) expect(f).not.toHaveBeenCalled();
  });
});

describe("unauthorised approval is rejected", () => {
  beforeEach(() => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
  });
  it("approveClaimAction needs the org-admin role", async () => {
    const r = await actions.approveClaimAction("p1", "c1");
    expect(r).toEqual({ ok: false, error: NOT_ADMIN });
    expect(store.approveClaim).not.toHaveBeenCalled();
  });
  it("changing APPROVED commercial completion needs the org-admin role", async () => {
    const r = await actions.recordProgressAction("p1", "s1", "50", "40", "reason");
    expect(r.ok).toBe(false);
    expect(store.recordProgress).not.toHaveBeenCalled();
  });
  it("seeding the fixture needs the org-admin role", async () => {
    expect((await actions.seedGoldenProjectAction()).ok).toBe(false);
    expect(store.seedGoldenFixture).not.toHaveBeenCalled();
  });
  it("setting opening commitments needs the org-admin (manager) role", async () => {
    expect(await actions.setOpeningCommitmentsAction("p1", [{ stageId: "s1", rands: "1000000" }], "r")).toEqual({ ok: false, error: NOT_ADMIN });
    expect(store.setOpeningCommitments).not.toHaveBeenCalled();
  });
  it("approving or rejecting a VARIATION needs the org-admin (manager) role", async () => {
    expect(await actions.approveVariationAction("p1", "v1")).toEqual({ ok: false, error: NOT_ADMIN });
    expect((await actions.rejectVariationAction("p1", "v1", "no")).ok).toBe(false);
    expect(variationStore.approveVariation).not.toHaveBeenCalled();
    expect(variationStore.rejectVariation).not.toHaveBeenCalled();
  });
  it("raising and pricing a variation (estimator) does not need the admin role", async () => {
    expect((await actions.raiseVariationAction("p1", "Additional Ventilation", "", "480000")).ok).toBe(true);
    expect((await actions.repriceVariationAction("p1", "v1", "500000")).ok).toBe(true);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
    expect(variationStore.raiseVariation).toHaveBeenCalledWith(expect.anything(), "org-session", "u@x", expect.objectContaining({ amountCents: 48_000_000 }));
  });
  it("recording only PHYSICAL progress does not need the admin role", async () => {
    const r = await actions.recordProgressAction("p1", "s1", "50", null, "");
    expect(r.ok).toBe(true);
    // the role is consulted only to decide who may operate an internal billing scope; physical progress itself never requires it
    expect(requireOrgAdmin).not.toHaveBeenCalledWith("approve commercial completion");
    expect(store.recordProgress).toHaveBeenCalled();
  });
});

describe("viewer permissions are display-only", () => {
  it("reports canApprove=true for an owner/admin and false (not an error) for a plain module user", async () => {
    expect(await actions.getViewerPermissionsAction()).toEqual({ ok: true, data: { canApprove: true } });
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
    expect(await actions.getViewerPermissionsAction()).toEqual({ ok: true, data: { canApprove: false } });
  });
  it("hiding the controls does not relax the server: a non-admin still cannot approve", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
    expect((await actions.approveClaimAction("p1", "c1")).ok).toBe(false);
    expect((await actions.recordProgressAction("p1", "s1", "50", "40", "reason")).ok).toBe(false);
    expect((await actions.seedGoldenProjectAction()).ok).toBe(false);
  });
});

describe("tenant is derived from the session, never from a caller argument", () => {
  it("every store call receives the session org id", async () => {
    await actions.getProjectAction("p-from-another-org");
    await actions.previewClaimAction("p-from-another-org");
    await actions.createClaimDraftAction("p-from-another-org");
    expect(vi.mocked(store.loadProjectView).mock.calls[0][1]).toBe("org-session");
    expect(vi.mocked(store.previewClaim).mock.calls[0][1]).toBe("org-session");
    expect(vi.mocked(store.createClaimDraft).mock.calls[0][1]).toBe("org-session");
  });
  it("action signatures carry no org id parameter (arity = project/claim ids + stage selection only)", () => {
    expect(actions.getProjectAction.length).toBe(1);
    expect(actions.previewClaimAction.length).toBe(2); // projectId, selectedStageIds?
    expect(actions.createClaimDraftAction.length).toBe(2);
    expect(actions.approveClaimAction.length).toBe(2); // projectId, claimId
  });
});
