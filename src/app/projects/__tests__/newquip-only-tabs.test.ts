// Variations and Products & Fulfilment are NewQuip-only: every related server action refuses another organisation (direct invocation included),
// refuses BEFORE touching any data, and keeps NewQuip's own permissions (manager approvals, cost redaction) as they were.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { NEWQUIP_ONLY_MESSAGE } from "@/lib/projects/newquip-gate";
import * as actions from "../actions";
import * as billing from "../variation-billing-actions";
import * as physical from "../physical-actions";
import * as delivery from "../delivery-actions";
import * as profit from "../profitability-actions";
import * as cin7 from "../cin7-actions";
import * as variationStore from "@/lib/projects/variation-store";
import * as billingStore from "@/lib/projects/variation-billing-store";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/scope-access", async (orig) => ({ ...(await orig<typeof import("@/lib/projects/scope-access")>()), guardBillingScope: vi.fn(() => Promise.resolve()), callerIsOrgAdmin: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@/lib/projects/project-store", () => ({ loadProjectView: vi.fn(() => Promise.resolve(null)), listProjectViews: vi.fn(() => Promise.resolve([])) }));
vi.mock("@/lib/projects/variation-store", () => ({
  raiseVariation: vi.fn(() => Promise.resolve({ variationId: "v1", code: "V001" })), repriceVariation: vi.fn(), approveVariation: vi.fn(), rejectVariation: vi.fn(),
}));
vi.mock("@/lib/projects/variation-billing-store", () => ({
  loadConsolidatedProject: vi.fn(() => Promise.resolve(null)), listVariationStages: vi.fn(() => Promise.resolve([])), saveDraftSchedule: vi.fn(), amendVariationSchedule: vi.fn(),
  createVariationBillingProject: vi.fn(() => Promise.resolve({ billingProjectId: "b1" })),
}));
vi.mock("@/lib/projects/physical-store", () => ({ loadPhysicalStatus: vi.fn() }));
vi.mock("@/lib/projects/cin7-store", () => ({ loadSaleLink: vi.fn(() => Promise.resolve(null)) }));

const OTHER = { orgId: "some-other-org", userId: "u1", email: "u@x" };
const NQ = { orgId: NEWQUIP_POC_ORG_IDS[0], userId: "u1", email: "u@x" };
const ROWS = [{ name: "Delivery", percent: "100" }];

const CALLS: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
  ["raiseVariationAction", () => actions.raiseVariationAction("p1", "V", "", "100")],
  ["repriceVariationAction", () => actions.repriceVariationAction("p1", "v1", "100")],
  ["approveVariationAction", () => actions.approveVariationAction("p1", "v1")],
  ["rejectVariationAction", () => actions.rejectVariationAction("p1", "v1", "no")],
  ["getVariationBillingAction", () => billing.getVariationBillingAction("p1")],
  ["saveVariationScheduleAction", () => billing.saveVariationScheduleAction("p1", "v1", ROWS)],
  ["startVariationBillingAction", () => billing.startVariationBillingAction("p1", "v1", [])],
  ["amendVariationScheduleAction", () => billing.amendVariationScheduleAction("p1", "v1", ROWS, "reason")],
  ["getPhysicalStatusAction", () => physical.getPhysicalStatusAction("p1")],
  ["searchVariationProductsAction", () => billing.searchVariationProductsAction("vent")],
  ["getConsolidatedCommercialAction", () => billing.getConsolidatedCommercialAction("p1")],
  ["getDeliveryRegisterAction", () => delivery.getDeliveryRegisterAction("p1")],
  ["createDeliveryAction", () => delivery.createDeliveryAction("p1", "Truck 1")],
  ["setAllocationAction", () => delivery.setAllocationAction("p1", "d1", "SKU", 1, "why")],
  ["setDeliveryStatusAction", () => delivery.setDeliveryStatusAction("p1", "d1", "LOADING", "why")],
  ["confirmMilestoneAction", () => delivery.confirmMilestoneAction("p1", "s1", "note")],
  ["getCostLedgerAction", () => profit.getCostLedgerAction("p1")],
  ["addCostEntryAction", () => profit.addCostEntryAction("p1", { category: "OTHER_DIRECT", description: "x", amountRand: "1", state: "COMMITTED" })],
  ["markCostIncurredAction", () => profit.markCostIncurredAction("p1", "e1")],
  ["voidCostEntryAction", () => profit.voidCostEntryAction("p1", "e1", "why")],
  ["getCostingReportAction", () => profit.getCostingReportAction("p1")],
];
const dataFns = () => [...Object.values(variationStore), ...Object.values(billingStore)].filter((f) => typeof f === "function") as unknown as Array<ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireOrgAdmin).mockResolvedValue(OTHER as never);
});

describe("another organisation is refused by every Variations / Products & Fulfilment action, directly invoked", () => {
  it.each(CALLS)("%s: denied, and no data layer is touched (not even a database client)", async (_n, run) => {
    vi.mocked(requireModuleAccess).mockResolvedValue(OTHER as never);
    const r = await run();
    expect(r).toMatchObject({ ok: false, error: NEWQUIP_ONLY_MESSAGE });
    for (const f of dataFns()) expect(f).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
  it("even an owner/admin of another organisation is refused (the check is the organisation, not the role)", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(OTHER as never);
    vi.mocked(requireOrgAdmin).mockResolvedValue(OTHER as never);
    for (const [, run] of CALLS) expect(await run()).toMatchObject({ ok: false, error: NEWQUIP_ONLY_MESSAGE });
  });
  it("module access is still established first: a user without Projects access gets the module error, not the organisation one", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("You don't have access to this feature."));
    for (const [, run] of CALLS) expect(await run()).toMatchObject({ ok: false, error: "You don't have access to this feature." });
  });
});

describe("NewQuip keeps its permissions", () => {
  beforeEach(() => vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never));
  it("a member can raise and price a variation; approval and rejection stay manager-only", async () => {
    expect((await actions.raiseVariationAction("p1", "V", "", "100")).ok).toBe(true);
    expect((await actions.repriceVariationAction("p1", "v1", "100")).ok).toBe(true);
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can do that."));
    expect(await actions.approveVariationAction("p1", "v1")).toEqual({ ok: false, error: "Only an org owner or admin can do that." });
    expect((await actions.rejectVariationAction("p1", "v1", "no")).ok).toBe(false);
    expect(variationStore.approveVariation).not.toHaveBeenCalled();
    vi.mocked(requireOrgAdmin).mockResolvedValue(NQ as never);
    expect((await actions.approveVariationAction("p1", "v1")).ok).toBe(true);
  });
  it("the billing and products actions are allowed through to their (unchanged) logic", async () => {
    expect(await billing.getVariationBillingAction("p1")).toEqual({ ok: false, error: "Project not found." }); // reached the store: the guard let it in
    expect(billingStore.loadConsolidatedProject).toHaveBeenCalled();
  });
  it("a non-admin NewQuip user's estimated cost on a variation is still ignored", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("no"));
    await actions.raiseVariationAction("p1", "V", "", "100", "40");
    expect(variationStore.raiseVariation).toHaveBeenCalledWith(expect.anything(), NQ.orgId, "u@x", expect.objectContaining({ estimatedCostCents: null }));
  });
});

describe("the tabs are hidden through the viewer-permissions flag", () => {
  it("reports newquip=false for another organisation and true for NewQuip (display only; the actions above are the control)", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(OTHER as never);
    expect((await actions.getViewerPermissionsAction()).data).toMatchObject({ newquip: false });
    vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never);
    expect((await actions.getViewerPermissionsAction()).data).toMatchObject({ newquip: true });
  });
});

describe("stock shortage stays advisory", () => {
  it("neither quotation approval nor Advanced Sale creation reads stock", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/projects/cin7-sale-creation-store.ts", "src/lib/projects/cin7-sale-creation.ts", "src/lib/projects/scope-store.ts", "src/newquip/quote/baseline.ts", "src/lib/newquip-quotes/quote-store.ts"]) {
      let src = ""; try { src = readFileSync(f, "utf8"); } catch { continue; }
      expect(src.replace(/^\s*(\/\/|\*).*$/gm, ""), f).not.toMatch(/\.stockAt\(|\.readStock\(|available\s*[<>]|STOCK_/);
    }
  });
});

describe("package mapping actions (cin7-actions) are refused for another organisation too", () => {
  it.each([
    ["resolveScopeItemAction MAP_LINES", () => cin7.resolveScopeItemAction("p1", { itemId: "i", kind: "MAP_LINES", lines: [{ sku: "A", factor: 1 }], reason: "r" })],
    ["resolveScopeItemAction saved version", () => cin7.resolveScopeItemAction("p1", { itemId: "i", kind: "MAP_LINES", useSavedVersion: 1, reason: "r" })],
    ["getPackageMappingAction", () => cin7.getPackageMappingAction("p1", "i")],
  ])("%s", async (_n, run) => {
    vi.mocked(requireModuleAccess).mockResolvedValue(OTHER as never);
    expect(await run()).toMatchObject({ ok: false, error: expect.stringMatching(/Not enabled/) });
  });
});

describe("other write paths stay manager-only inside NewQuip", () => {
  beforeEach(() => vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never));
  it("delivery changes, cost entries and the catalogue search need an owner/admin", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can do that."));
    for (const run of [() => delivery.createDeliveryAction("p1", "T"), () => delivery.setAllocationAction("p1", "d", "S", 1, "r"), () => delivery.confirmMilestoneAction("p1", "s", "n"), () => profit.addCostEntryAction("p1", { category: "OTHER_DIRECT", description: "x", amountRand: "1", state: "COMMITTED" }), () => profit.getCostingReportAction("p1"), () => billing.searchVariationProductsAction("vent")]) {
      expect(await run()).toEqual({ ok: false, error: "Only an org owner or admin can do that." });
    }
  });
});
