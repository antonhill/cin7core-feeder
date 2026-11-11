import { describe, expect, it } from "vitest";
import { assessRefresh, isMissingFunctionError, isRateLimitStop, loadPurchaseSyncConfig, receivingStatusImpliesReceipts } from "@/sync/purchase-refresh-policy";
import type { PurchaseDetail } from "@/cin7/purchase-detail";
import { Cin7ApiError } from "@/cin7/http";

const detail = (over: Partial<PurchaseDetail> & { receipts?: number[]; orders?: number[] } = {}): PurchaseDetail => ({
  source: "purchase",
  isDropShip: false,
  receiptSectionPresent: true,
  orderLines: (over.orders ?? [10]).map((quantity, i) => ({ productSku: `S${i}`, productName: "n", quantity })),
  receiptLines: (over.receipts ?? [4]).map((quantity, i) => ({ cardId: `c${i}`, productSku: "S0", productName: "n", quantity, receivedDate: "2026-11-01", location: "Main", locationId: "l" })),
  ...over,
});
const cached = (o: Partial<{ orderLines: number; orderQty: number; receiptRows: number; receiptQty: number }> = {}) => ({ orderLines: 1, orderQty: 10, receiptRows: 1, receiptQty: 4, ...o });

describe("assessRefresh", () => {
  it("accepts an unchanged response and reports changed=false", () => {
    const v = assessRefresh(cached(), detail(), "PARTIALLY RECEIVED");
    expect(v.reject).toBeNull();
    expect(v.changed).toBe(false);
  });

  it("flags a receipt change WITHOUT any status change (a further partial receipt)", () => {
    const v = assessRefresh(cached(), detail({ receipts: [4, 3] }), "PARTIALLY RECEIVED");
    expect(v).toMatchObject({ reject: null, changed: true, fresh: { receiptQty: 7, receiptRows: 2 } });
  });

  it("flags changed ordered quantities and line counts", () => {
    expect(assessRefresh(cached(), detail({ orders: [12] }), "NOT RECEIVED").changed).toBe(true);
    expect(assessRefresh(cached(), detail({ orders: [10, 5] }), "NOT RECEIVED").changed).toBe(true);
  });

  it("handles partial, complete and over-received responses as ordinary data", () => {
    expect(assessRefresh(cached({ receiptQty: 4 }), detail({ receipts: [10] }), "FULLY RECEIVED")).toMatchObject({ reject: null, changed: true });
    expect(assessRefresh(cached({ receiptQty: 10 }), detail({ receipts: [10, 5] }), "FULLY RECEIVED")).toMatchObject({ reject: null, changed: true, fresh: { receiptQty: 15 } });
  });

  it("REJECTS zero receipts when Cin7's list status says received and receipts are cached (incomplete/contradictory answer)", () => {
    for (const status of ["PARTIALLY RECEIVED", "FULLY RECEIVED"]) {
      const v = assessRefresh(cached(), detail({ receipts: [] }), status);
      expect(v.reject?.code).toBe("zero_receipts_contradicts_status");
    }
  });

  it("ACCEPTS zero receipts when the list status is NOT RECEIVED (a legitimately reversed receipt)", () => {
    expect(assessRefresh(cached(), detail({ receipts: [] }), "NOT RECEIVED")).toMatchObject({ reject: null, changed: true });
  });

  it("REJECTS a response with no receipt section at all while receipts are cached, but not a present-and-empty section", () => {
    expect(assessRefresh(cached(), detail({ receipts: [], receiptSectionPresent: false }), "NOT RECEIVED").reject?.code).toBe("receipt_section_missing");
    expect(assessRefresh(cached(), detail({ receipts: [], receiptSectionPresent: true }), "NOT RECEIVED").reject).toBeNull();
  });

  it("REJECTS vanished order lines, but never rejects when nothing was cached (first sync / Service Purchase)", () => {
    expect(assessRefresh(cached(), detail({ orders: [] }), "NOT RECEIVED").reject?.code).toBe("order_lines_missing");
    expect(assessRefresh(null, detail({ orders: [], receipts: [] }), "NOT AVAILABLE").reject).toBeNull();
    expect(assessRefresh(cached({ orderLines: 0, orderQty: 0, receiptRows: 0, receiptQty: 0 }), detail({ orders: [], receipts: [] }), "NOT AVAILABLE").reject).toBeNull();
  });

  it("treats float noise as unchanged", () => {
    expect(assessRefresh(cached({ receiptQty: 0.3 }), detail({ receipts: [0.1, 0.2] }), "PARTIALLY RECEIVED").changed).toBe(true); // 2 rows vs 1 row
    expect(assessRefresh(cached({ receiptRows: 2, receiptQty: 0.3 }), detail({ receipts: [0.1, 0.2] }), "PARTIALLY RECEIVED").changed).toBe(false);
  });

  it("receivingStatusImpliesReceipts", () => {
    expect(receivingStatusImpliesReceipts("PARTIALLY RECEIVED")).toBe(true);
    expect(receivingStatusImpliesReceipts("NOT RECEIVED")).toBe(false);
    expect(receivingStatusImpliesReceipts(null)).toBe(false);
  });
});

describe("loadPurchaseSyncConfig", () => {
  it("defaults to a conservative reservation: 60 fetches/run, 24h TTL, 10 min overlap", () => {
    expect(loadPurchaseSyncConfig({})).toEqual({ maxPerRun: 60, openTtlHours: 24, listOverlapMinutes: 10, safetyMs: 45_000 });
  });
  it("is configurable but bounded, and ignores garbage", () => {
    expect(loadPurchaseSyncConfig({ PURCHASE_DETAIL_MAX_PER_RUN: "999", PURCHASE_OPEN_TTL_HOURS: "0", PURCHASE_LIST_OVERLAP_MINUTES: "-5" })).toMatchObject({ maxPerRun: 200, openTtlHours: 1, listOverlapMinutes: 0 });
    expect(loadPurchaseSyncConfig({ PURCHASE_DETAIL_MAX_PER_RUN: "abc", PURCHASE_OPEN_TTL_HOURS: "" })).toMatchObject({ maxPerRun: 60, openTtlHours: 24 });
    expect(loadPurchaseSyncConfig({ PURCHASE_OPEN_TTL_HOURS: "12" }).openTtlHours).toBe(12);
  });
});

describe("error classifiers", () => {
  it("recognises a not-yet-deployed function", () => {
    expect(isMissingFunctionError({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingFunctionError({ code: "42883", message: "x" })).toBe(true);
    expect(isMissingFunctionError({ message: "Could not find the function public.purchase_refresh_queue" })).toBe(true);
    expect(isMissingFunctionError({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });
  it("stops on rate limiting but not on ordinary failures", () => {
    expect(isRateLimitStop(new Cin7ApiError(503, "Rate limited (60 calls/min) and retries exhausted", true))).toBe(true);
    expect(isRateLimitStop(new Error("Rate limit coordinator unavailable or contended"))).toBe(true);
    expect(isRateLimitStop(new Cin7ApiError(400, "bad", false))).toBe(false);
    expect(isRateLimitStop(new Error("boom"))).toBe(false);
  });
});
