import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";
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
