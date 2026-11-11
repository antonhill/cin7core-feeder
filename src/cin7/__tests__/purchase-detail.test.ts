import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchPurchaseDetail, aggregateReceiptLines, ReceiptLineConflictError, type PurchaseReceiptLine } from "@/cin7/purchase-detail";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchPurchaseDetail", () => {
  it("reads StockReceived.Lines[] from the classic /purchase endpoint", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: {
        Lines: [{ CardID: "card-1", SKU: "SKU-A", Name: "Widget", Quantity: 5, Date: "2026-01-30T00:00:00", Location: "Main", LocationID: "loc-1" }],
      },
    });

    const result = await fetchPurchaseDetail(creds, "po-1");

    expect(result.source).toBe("purchase");
    expect(result.receiptLines).toEqual([
      { cardId: "card-1", productSku: "SKU-A", productName: "Widget", quantity: 5, receivedDate: "2026-01-30", location: "Main", locationId: "loc-1" },
    ]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/purchase", { query: { ID: "po-1", CombineAdditionalCharges: "false" } });
  });

  it("falls back to /advanced-purchase and reads PutAway[].Lines[] when the classic endpoint rejects it as Advanced/Service", async () => {
    vi.mocked(cin7Request)
      .mockRejectedValueOnce(
        new Cin7ApiError(400, '[{"ErrorCode":400,"Exception":"This endpoint is deprecated and does not support Advanced Purchase and Service Purchase. Please use AdvancedPurchase endpoint"}]', false)
      )
      .mockResolvedValueOnce({
        StockReceived: [{ TaskID: "t1", Status: "NOT AVAILABLE", Lines: [] }],
        PutAway: [
          {
            TaskID: "t1",
            Lines: [
              { CardID: "card-1", SKU: "SKU-A", Name: "Widget", Quantity: 5, Date: "2026-01-30T00:00:00", Location: "Main", LocationID: "loc-1" },
              { CardID: "card-2", SKU: "SKU-A", Name: "Widget", Quantity: 5, Date: "2026-01-31T00:00:00", Location: "Main", LocationID: "loc-1" },
            ],
          },
        ],
      });

    const result = await fetchPurchaseDetail(creds, "po-2");

    expect(result.source).toBe("advanced-purchase");
    expect(result.receiptLines).toHaveLength(2);
    expect(result.receiptLines.map((l) => l.cardId)).toEqual(["card-1", "card-2"]);
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/advanced-purchase", { query: { ID: "po-2", CombineAdditionalCharges: "false" } });
  });

  it("does not fall back for an unrelated error — propagates it instead", async () => {
    vi.mocked(cin7Request).mockRejectedValueOnce(new Cin7ApiError(503, "Rate limited", true));

    await expect(fetchPurchaseDetail(creds, "po-3")).rejects.toThrow("Rate limited");
    expect(cin7Request).toHaveBeenCalledTimes(1);
  });

  it("skips a received line with no CardID rather than crashing or fabricating a key", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: { Lines: [{ SKU: "SKU-A", Quantity: 1 }] },
    });

    const result = await fetchPurchaseDetail(creds, "po-4");

    expect(result.receiptLines).toEqual([]);
  });

  it("extracts Order.Lines[] as orderLines, on both classic and Advanced-purchase responses", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: { Lines: [] },
      Order: { Lines: [{ SKU: "SKU-A", Name: "Widget", Quantity: 10 }] },
    });

    const result = await fetchPurchaseDetail(creds, "po-5");

    expect(result.orderLines).toEqual([{ productSku: "SKU-A", productName: "Widget", quantity: 10 }]);
  });

  it("flags a drop-shipment when RelatedDropShipSaleTask is present", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: { Lines: [] },
      RelatedDropShipSaleTask: "af215596-2479-49d4-93ad-7db3dc1ca9f3",
    });

    const result = await fetchPurchaseDetail(creds, "po-6");

    expect(result.isDropShip).toBe(true);
  });

  it("defaults isDropShip to false and orderLines to [] when absent", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ StockReceived: { Lines: [] } });

    const result = await fetchPurchaseDetail(creds, "po-7");

    expect(result.isDropShip).toBe(false);
    expect(result.orderLines).toEqual([]);
  });
});


const L = (over: Partial<PurchaseReceiptLine> = {}): PurchaseReceiptLine => ({
  cardId: "card-1",
  productSku: "LBLINSTALLATIONNONIP",
  productName: "Installation",
  quantity: 1,
  receivedDate: "2026-10-29",
  location: "Main",
  locationId: "loc-1",
  ...over,
});

describe("aggregateReceiptLines — duplicate (CardID, SKU) collision", () => {
  it("PO-14939 pattern: four lines of one SKU in one batch collapse to one row totalling 380", () => {
    const out = aggregateReceiptLines([21, 20, 106, 233].map((quantity) => L({ quantity })));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cardId: "card-1", productSku: "LBLINSTALLATIONNONIP", quantity: 380, receivedDate: "2026-10-29", location: "Main", locationId: "loc-1" });
  });

  it("PO-13609 pattern: duplicates across three SKUs collapse per SKU, distinct keys are untouched, order preserved", () => {
    const out = aggregateReceiptLines([
      L({ productSku: "SKU-A", quantity: 5 }),
      L({ productSku: "SKU-B", quantity: 2 }),
      L({ productSku: "SKU-A", quantity: 7 }),
      L({ productSku: "SKU-C", quantity: 1 }),
      L({ productSku: "SKU-B", quantity: 3 }),
      L({ productSku: "SKU-C", quantity: 4 }),
      L({ cardId: "card-2", productSku: "SKU-A", quantity: 9 }),
    ]);
    expect(out.map((l) => [l.cardId, l.productSku, l.quantity])).toEqual([
      ["card-1", "SKU-A", 12],
      ["card-1", "SKU-B", 5],
      ["card-1", "SKU-C", 5],
      ["card-2", "SKU-A", 9],
    ]);
    // After aggregation every (cardId, sku) key is unique — i.e. the 0025 primary key can no longer be violated.
    expect(new Set(out.map((l) => `${l.cardId}|${l.productSku}`)).size).toBe(out.length);
  });

  it("preserves the grand total quantity exactly and avoids float noise", () => {
    const out = aggregateReceiptLines([L({ quantity: 0.1 }), L({ quantity: 0.2 })]);
    expect(out[0].quantity).toBe(0.3);
  });

  it("is idempotent: aggregating already-unique lines changes nothing (repeat sync yields the same rows)", () => {
    const once = aggregateReceiptLines([21, 20, 106, 233].map((quantity) => L({ quantity })));
    expect(aggregateReceiptLines(once)).toEqual(once);
  });

  it.each([
    ["receivedDate", { receivedDate: "2026-10-30" }],
    ["location", { location: "Overflow" }],
    ["locationId", { locationId: "loc-2" }],
  ])("refuses to merge lines that differ in %s (no silent information loss)", (field, diff) => {
    expect(() => aggregateReceiptLines([L({ quantity: 1 }), L({ quantity: 2, ...diff })])).toThrow(ReceiptLineConflictError);
    try {
      aggregateReceiptLines([L(), L(diff)]);
    } catch (e) {
      expect((e as ReceiptLineConflictError).conflictingFields).toContain(field);
      expect((e as Error).message).not.toContain("loc-");
    }
  });

  it("fetchPurchaseDetail returns aggregated lines for both classic and advanced shapes", async () => {
    const lines = [21, 20, 106, 233].map((q) => ({ CardID: "card-1", SKU: "LBLINSTALLATIONNONIP", Name: "Installation", Quantity: q, Date: "2026-10-29T00:00:00", Location: "Main", LocationID: "loc-1" }));
    vi.mocked(cin7Request).mockResolvedValueOnce({ StockReceived: { Lines: lines } });
    const classic = await fetchPurchaseDetail(creds, "po-classic");
    expect(classic.receiptLines).toHaveLength(1);
    expect(classic.receiptLines[0].quantity).toBe(380);

    vi.mocked(cin7Request)
      .mockRejectedValueOnce(new Cin7ApiError(400, "This is an Advanced Purchase order. Please use AdvancedPurchase endpoint", false))
      .mockResolvedValueOnce({ PutAway: [{ Lines: lines }] });
    const advanced = await fetchPurchaseDetail(creds, "po-adv");
    expect(advanced.source).toBe("advanced-purchase");
    expect(advanced.receiptLines).toHaveLength(1);
    expect(advanced.receiptLines[0].quantity).toBe(380);
  });

  it("a date/location conflict fails the fetch (not silently merged) and does not trigger the advanced-endpoint fallback", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: {
        Lines: [
          { CardID: "c", SKU: "A", Quantity: 1, Date: "2026-10-29T00:00:00", Location: "Main", LocationID: "l1" },
          { CardID: "c", SKU: "A", Quantity: 1, Date: "2026-10-30T00:00:00", Location: "Main", LocationID: "l1" },
        ],
      },
    });
    await expect(fetchPurchaseDetail(creds, "po-x")).rejects.toBeInstanceOf(ReceiptLineConflictError);
    expect(cin7Request).toHaveBeenCalledTimes(1);
  });
});
