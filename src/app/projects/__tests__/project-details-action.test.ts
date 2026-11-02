import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { listOrgUsers } from "@/lib/approvals/role-store";
import { logActivity } from "@/lib/activity-log";
import * as detailsStore from "@/lib/projects/project-details-store";
import { guardBillingScope } from "@/lib/projects/scope-access";
import * as actions from "../actions";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ listOrgUsers: vi.fn() }));
vi.mock("@/lib/projects/scope-access", async (orig) => ({ ...(await orig<typeof import("@/lib/projects/scope-access")>()), guardBillingScope: vi.fn(() => Promise.resolve()) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/project-store", () => ({}));
vi.mock("@/lib/projects/variation-store", () => ({}));
vi.mock("@/lib/projects/project-details-store", () => ({
  updateProjectDetails: vi.fn((_db, _org, _id, patch) => Promise.resolve({ before: { project_manager: null, start_date: null, target_completion_date: null }, after: patch })),
}));

const SESSION = { orgId: "org-1", userId: "u1", email: "boss@x.co.za" };
const USERS = [{ email: "pm@x.co.za" }, { email: "boss@x.co.za" }];
const GOOD = { projectManager: "pm@x.co.za", startDate: "2026-11-03", targetCompletionDate: "2027-02-01" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockResolvedValue(SESSION as never);
  vi.mocked(listOrgUsers).mockResolvedValue(USERS as never);
});

describe("updateProjectDetailsAction", () => {
  it("saves a valid edit, scoped to the session organisation, and audits before and after", async () => {
    expect(await actions.updateProjectDetailsAction("p1", GOOD)).toEqual({ ok: true, data: null });
    expect(detailsStore.updateProjectDetails).toHaveBeenCalledWith({ __db: true }, "org-1", "p1", { project_manager: "pm@x.co.za", start_date: "2026-11-03", target_completion_date: "2027-02-01" });
    const log = vi.mocked(logActivity).mock.calls[0][1];
    expect(log).toMatchObject({ orgId: "org-1", action: "projects.details_updated", detail: { projectId: "p1", before: { project_manager: null }, after: { project_manager: "pm@x.co.za" } } });
  });
  it("is owner/admin only: a plain user is refused and nothing is read or written", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can edit project details."));
    const r = await actions.updateProjectDetailsAction("p1", GOOD);
    expect(r).toEqual({ ok: false, error: "Only an org owner or admin can edit project details." });
    expect(listOrgUsers).not.toHaveBeenCalled();
    expect(detailsStore.updateProjectDetails).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
  it("module access is re-established first", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("You don't have access to this feature."));
    expect((await actions.updateProjectDetailsAction("p1", GOOD)).ok).toBe(false);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
    expect(detailsStore.updateProjectDetails).not.toHaveBeenCalled();
  });
  it("a manager who is not a user of the organisation is refused with nothing written", async () => {
    const r = await actions.updateProjectDetailsAction("p1", { ...GOOD, projectManager: "stranger@elsewhere.com" });
    expect(r).toEqual({ ok: false, error: "The project manager must be a user of this organisation." });
    expect(detailsStore.updateProjectDetails).not.toHaveBeenCalled();
  });
  it("impossible dates and a target before the start are refused with nothing written", async () => {
    expect((await actions.updateProjectDetailsAction("p1", { ...GOOD, startDate: "2026-02-30" })).ok).toBe(false);
    expect((await actions.updateProjectDetailsAction("p1", { ...GOOD, targetCompletionDate: "2026-11-01" })).ok).toBe(false);
    expect(detailsStore.updateProjectDetails).not.toHaveBeenCalled();
  });
  it("the billing-scope guard runs (an internal scope is not editable from here) and a refusal writes nothing", async () => {
    vi.mocked(guardBillingScope).mockRejectedValueOnce(new Error("Open the original project."));
    expect((await actions.updateProjectDetailsAction("p1", GOOD)).ok).toBe(false);
    expect(detailsStore.updateProjectDetails).not.toHaveBeenCalled();
  });
  it("accepts clearing all three", async () => {
    expect((await actions.updateProjectDetailsAction("p1", { projectManager: null, startDate: null, targetCompletionDate: null })).ok).toBe(true);
  });
});

describe("listProjectManagerOptionsAction", () => {
  it("is owner/admin only", async () => {
    expect(await actions.listProjectManagerOptionsAction()).toEqual({ ok: true, data: ["pm@x.co.za", "boss@x.co.za"] });
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("no"));
    expect((await actions.listProjectManagerOptionsAction()).ok).toBe(false);
  });
});
