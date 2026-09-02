import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSupplierPlanPurchaseOrdersAction } from "@/app/supplier-planner/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { createPurchaseOrder } from "@/cin7/purchase-write";
import { Cin7ApiError } from "@/cin7/http";
import { claimPoCreation, settlePoCreation, releasePoCreation, markPoCreationAmbiguous, findLikelyCreatedPurchaseOrder } from "@/lib/po-idempotency";
import { groupLinesForPurchaseOrders } from "@/reports/supplier-planner/build";
import { logActivity } from "@/lib/activity-log";
import { requireAal2 } from "@/lib/require-privileged";
import { requireOrgAdmin } from "@/lib/require-org-admin";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/purchase-write", () => ({ createPurchaseOrder: vi.fn() }));
vi.mock("@/lib/po-idempotency", () => ({
  poIdempotencyKey: vi.fn(() => "key-1"),
  claimPoCreation: vi.fn(),
  settlePoCreation: vi.fn(),
  releasePoCreation: vi.fn(),
  markPoCreationAmbiguous: vi.fn(),
  findLikelyCreatedPurchaseOrder: vi.fn(),
  PO_CLAIM_TTL_SECONDS: 900,
}));
vi.mock("@/reports/supplier-planner/build", () => ({
  groupLinesForPurchaseOrders: vi.fn(),
  buildSupplierPlanLines: vi.fn(),
}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/pending-purchase-orders", () => ({ loadPendingPurchaseOrders: vi.fn() }));
vi.mock("@/reports/supplier-planner-export", () => ({ buildSupplierPlanSheet: vi.fn() }));
vi.mock("@/reports/xlsx-writer", () => ({ renderXlsxBase64: vi.fn() }));
vi.mock("@/reports/query", () => ({ getReorderReport: vi.fn(), getSupplierPlanLocationDemand: vi.fn() }));
vi.mock("@/cin7/reference-lookups", () => ({ fetchAllLocations: vi.fn() }));
vi.mock("@/cin7/product-supplier-options", () => ({ fetchAllProductsForSupplierPlanning: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: vi.fn(), requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));

const CURRENT_ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const GROUP = {
  supplierId: "sup-1",
  supplierName: "Box Shop",
  locationId: "loc-1",
  locationName: "Main Warehouse",
  lines: [{ productId: "p1", productSku: "SKU1", productName: "Widget", suggestedQty: 5, cost: 10 }],
};
const FAKE_LINES = [{ productSku: "SKU1" }] as never;

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(CURRENT_ORG as never);
  vi.mocked(requireWriteAllowed).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(createServiceRoleClient)
    .mockReset()
    .mockReturnValue({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) } as never);
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue({} as never);
  vi.mocked(groupLinesForPurchaseOrders).mockReset().mockReturnValue([GROUP] as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined);
  vi.mocked(settlePoCreation).mockReset().mockResolvedValue(true);
  vi.mocked(releasePoCreation).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(markPoCreationAmbiguous).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(findLikelyCreatedPurchaseOrder).mockReset().mockResolvedValue(null);
  vi.mocked(createPurchaseOrder).mockReset();
  vi.mocked(claimPoCreation).mockReset();
  vi.mocked(requireAal2).mockReset().mockResolvedValue(undefined);
  vi.mocked(requireOrgAdmin).mockReset();
});

describe("security closure Blocker 7: createSupplierPlanPurchaseOrdersAction logs unconditionally", () => {
  it("logs a 100%-failed batch (zero PO objects ever created) — previously this produced ZERO activity_log rows", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createPurchaseOrder).mockRejectedValue(new Error("Cin7 rejected: invalid supplier"));

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(result.ok).toBe(false);
    expect(result.data?.created).toHaveLength(0);
    expect(logActivity).toHaveBeenCalledTimes(1);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.created).toBe(0);
    expect(detail.failed).toBe(1);
    expect(detail.requested).toBe(1);
  });

  it("distinguishes an ambiguous outcome (network lost, no reconciliation match) from a definite failure in the logged detail", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createPurchaseOrder).mockRejectedValue(new Cin7ApiError(0, "network lost", false, true));
    vi.mocked(findLikelyCreatedPurchaseOrder).mockResolvedValue(null);

    await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.ambiguous).toBe(1);
    expect(detail.failed).toBe(0);
  });

  it("logs a definite failure (not ambiguous) as 'failed', not lumped in with ambiguous", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createPurchaseOrder).mockRejectedValue(new Cin7ApiError(400, "rejected", false, false));

    await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.failed).toBe(1);
    expect(detail.ambiguous).toBe(0);
  });

  it("logs 'blocked' (not 'failed') when the idempotency guard itself is unavailable", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: false, existingStatus: "guard_unavailable" } as never);

    await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(createPurchaseOrder).not.toHaveBeenCalled();
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.blocked).toBe(1);
    expect(detail.failed).toBe(0);
    expect(detail.ambiguous).toBe(0);
  });

  it("security re-audit closure Blocker 5, Scenario D: Cin7 succeeds but settlePoCreation's own write fails — falls back to markPoCreationAmbiguous instead of leaving the claim silently stranded at 'pending'", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createPurchaseOrder).mockResolvedValue({ orderNumber: "PO-1", status: "DRAFT", lineCount: 1, taskId: "task-1" } as never);
    vi.mocked(settlePoCreation).mockResolvedValue(false); // the settle write itself fails

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(result.ok).toBe(true); // the PO WAS genuinely created in Cin7 -- this isn't a create failure
    expect(markPoCreationAmbiguous).toHaveBeenCalledWith(expect.anything(), "org1", "inst-1", "key-1");
  });

  it("does NOT call markPoCreationAmbiguous when settlePoCreation succeeds (no over-correction)", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createPurchaseOrder).mockResolvedValue({ orderNumber: "PO-1", status: "DRAFT", lineCount: 1, taskId: "task-1" } as never);
    vi.mocked(settlePoCreation).mockResolvedValue(true);

    await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(markPoCreationAmbiguous).not.toHaveBeenCalled();
  });

  it("still logs (with created > 0) on a successful batch, preserving pre-existing behavior", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createPurchaseOrder).mockResolvedValue({ orderNumber: "PO-1", status: "DRAFT", lineCount: 1, taskId: "task-1" } as never);

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(result.ok).toBe(true);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.created).toBe(1);
  });
});

/**
 * CCT-ADR-0015 (2026-09-02): Purchase Order creation stays available to an
 * ordinary member but requires a step-up (AAL2). These tests pin both halves
 * — the assurance requirement AND the deliberate absence of an admin-role
 * requirement — so neither can be lost or over-tightened silently.
 */
describe("CCT-ADR-0015: PO creation requires AAL2 but not an admin role", () => {
  it("an ordinary member with module access, write eligibility and AAL2 reaches PO creation", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true, existingStatus: null } as never);
    vi.mocked(createPurchaseOrder).mockResolvedValue({ taskId: "po-1", orderNumber: "PO-1" } as never);

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(requireAal2).toHaveBeenCalledTimes(1);
    expect(createPurchaseOrder).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("denies before Cin7 is called when the session has not stepped up", async () => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required to create a Purchase Order."));

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(result.ok).toBe(false);
    // The whole point: no Cin7 traffic, and no claim taken, on an assurance failure.
    expect(createPurchaseOrder).not.toHaveBeenCalled();
    expect(claimPoCreation).not.toHaveBeenCalled();
    expect(loadCin7Credentials).not.toHaveBeenCalled();
  });

  it("fails closed when assurance state cannot be read at all", async () => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Could not verify two-factor authentication status: network"));

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(result.ok).toBe(false);
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it("does NOT newly require an org-admin role", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true, existingStatus: null } as never);
    vi.mocked(createPurchaseOrder).mockResolvedValue({ taskId: "po-1", orderNumber: "PO-1" } as never);

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(requireOrgAdmin).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("still applies the module gate before assurance", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("You don't have access to this feature."));

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(result.ok).toBe(false);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it("still applies the billing write gate before assurance", async () => {
    vi.mocked(requireWriteAllowed).mockRejectedValue(new Error("read-only during the trial"));

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    expect(result.ok).toBe(false);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it("leaves claim/reconciliation behaviour unchanged once assurance passes", async () => {
    vi.mocked(claimPoCreation).mockResolvedValue({ claimed: true, existingStatus: null } as never);
    vi.mocked(createPurchaseOrder).mockRejectedValue(new Cin7ApiError(0, "network", false, true));

    const result = await createSupplierPlanPurchaseOrdersAction("inst-1", FAKE_LINES);

    // An ambiguous create still marks the claim ambiguous rather than releasing it,
    // and is still reported as ambiguous (not lumped in with a definite failure).
    expect(markPoCreationAmbiguous).toHaveBeenCalledTimes(1);
    expect(releasePoCreation).not.toHaveBeenCalled();
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.ambiguous).toBe(1);
    expect(detail.failed).toBe(0);
    void result;
  });
});
