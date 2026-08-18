import { describe, expect, it, vi, beforeEach } from "vitest";
import { createReplenishTransfersAction } from "@/app/replenish/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { createStockTransfer } from "@/cin7/stock-transfers";
import { Cin7ApiError } from "@/cin7/http";
import {
  claimStockTransferCreation,
  settleStockTransferCreation,
  releaseStockTransferCreation,
  markStockTransferCreationAmbiguous,
  findLikelyCreatedStockTransfer,
} from "@/lib/stock-transfer-idempotency";
import { logActivity } from "@/lib/activity-log";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/stock-transfers", () => ({ createStockTransfer: vi.fn() }));
vi.mock("@/lib/stock-transfer-idempotency", () => ({
  stockTransferIdempotencyKey: vi.fn(() => "key-1"),
  claimStockTransferCreation: vi.fn(),
  settleStockTransferCreation: vi.fn(),
  releaseStockTransferCreation: vi.fn(),
  markStockTransferCreationAmbiguous: vi.fn(),
  findLikelyCreatedStockTransfer: vi.fn(),
  STOCK_TRANSFER_CLAIM_TTL_SECONDS: 900,
}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/reports/query", () => ({ getProductAvailabilitySyncStatus: vi.fn() }));
vi.mock("@/sync/sync-product-availability", () => ({ syncOrgProductAvailability: vi.fn() }));
vi.mock("@/reports/replenish/build", () => ({ resolveReorderThresholds: vi.fn() }));
vi.mock("@/cin7/product-reorder", () => ({ fetchAllProductsForReplenish: vi.fn() }));

const CURRENT_ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const LINES = [{ productSku: "SKU1", toLocation: "Retail", quantity: 3 }] as never;

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(CURRENT_ORG as never);
  vi.mocked(requireWriteAllowed).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(createServiceRoleClient)
    .mockReset()
    .mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }) }) }),
      }),
    } as never);
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue({} as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined);
  vi.mocked(settleStockTransferCreation).mockReset().mockResolvedValue(true);
  vi.mocked(releaseStockTransferCreation).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(markStockTransferCreationAmbiguous).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(findLikelyCreatedStockTransfer).mockReset().mockResolvedValue(null);
  vi.mocked(createStockTransfer).mockReset();
  vi.mocked(claimStockTransferCreation).mockReset();
});

describe("security closure Blocker 7: createReplenishTransfersAction logs unconditionally", () => {
  it("logs a 100%-failed batch (zero transfers ever created) — previously this produced ZERO activity_log rows", async () => {
    vi.mocked(claimStockTransferCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createStockTransfer).mockRejectedValue(new Error("Cin7 rejected: invalid location"));

    const result = await createReplenishTransfersAction("inst-1", "Main Warehouse", LINES);

    expect(result.ok).toBe(false);
    expect(result.data?.created).toHaveLength(0);
    expect(logActivity).toHaveBeenCalledTimes(1);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.created).toBe(0);
    expect(detail.failed).toBe(1);
    expect(detail.requested).toBe(1);
  });

  it("distinguishes an ambiguous outcome from a definite failure in the logged detail", async () => {
    vi.mocked(claimStockTransferCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createStockTransfer).mockRejectedValue(new Cin7ApiError(0, "network lost", false, true));

    await createReplenishTransfersAction("inst-1", "Main Warehouse", LINES);

    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.ambiguous).toBe(1);
    expect(detail.failed).toBe(0);
  });

  it("logs 'blocked' (not 'failed') when the idempotency guard itself is unavailable", async () => {
    vi.mocked(claimStockTransferCreation).mockResolvedValue({ claimed: false, existingStatus: "guard_unavailable" } as never);

    await createReplenishTransfersAction("inst-1", "Main Warehouse", LINES);

    expect(createStockTransfer).not.toHaveBeenCalled();
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.blocked).toBe(1);
    expect(detail.failed).toBe(0);
  });

  it("security re-audit closure Blocker 5, Scenario D: Cin7 succeeds but settleStockTransferCreation's own write fails — falls back to markStockTransferCreationAmbiguous instead of leaving the claim silently stranded at 'pending'", async () => {
    vi.mocked(claimStockTransferCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createStockTransfer).mockResolvedValue({ taskId: "task-1", number: "ST-1", status: "DRAFT" } as never);
    vi.mocked(settleStockTransferCreation).mockResolvedValue(false);

    const result = await createReplenishTransfersAction("inst-1", "Main Warehouse", LINES);

    expect(result.ok).toBe(true); // the transfer WAS genuinely created in Cin7 -- this isn't a create failure
    expect(markStockTransferCreationAmbiguous).toHaveBeenCalledWith(expect.anything(), "org1", "inst-1", "key-1");
  });

  it("does NOT call markStockTransferCreationAmbiguous when settleStockTransferCreation succeeds (no over-correction)", async () => {
    vi.mocked(claimStockTransferCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createStockTransfer).mockResolvedValue({ taskId: "task-1", number: "ST-1", status: "DRAFT" } as never);
    vi.mocked(settleStockTransferCreation).mockResolvedValue(true);

    await createReplenishTransfersAction("inst-1", "Main Warehouse", LINES);

    expect(markStockTransferCreationAmbiguous).not.toHaveBeenCalled();
  });

  it("still logs (with created > 0) on a successful batch, preserving pre-existing behavior", async () => {
    vi.mocked(claimStockTransferCreation).mockResolvedValue({ claimed: true } as never);
    vi.mocked(createStockTransfer).mockResolvedValue({ taskId: "task-1", number: "ST-1", status: "DRAFT" } as never);

    const result = await createReplenishTransfersAction("inst-1", "Main Warehouse", LINES);

    expect(result.ok).toBe(true);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.created).toBe(1);
  });
});
