import { describe, expect, it, vi, beforeEach } from "vitest";
import { probePurchaseReceipts } from "@/cin7/purchase-receipt-probe";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});
const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };
beforeEach(() => vi.mocked(cin7Request).mockReset());

/** Advanced purchase whose receipts live in StockReceived (PutAway empty): the parser stores nothing, the probe must show the gap. */
describe("probePurchaseReceipts", () => {
  it("surfaces receipts the parser would miss and lines without CardID, GET-only", async () => {
    const advanced = {
      Order: { Lines: [{ SKU: "A", Quantity: 10 }] },
      StockReceived: [{ Lines: [{ SKU: "A", Quantity: 6, CardID: "c1" }, { SKU: "A", Quantity: 4 }] }],
      PutAway: [],
    };
    vi.mocked(cin7Request).mockImplementation(async (_c, path) => {
      if (path === "/purchase") throw new Cin7ApiError(400, "Please use Advanced Purchase endpoint", false);
      return advanced;
    });
    const r = await probePurchaseReceipts(creds, "po1", { ordered: new Map([["A", 10]]), received: new Map() });
    expect(r.endpoint).toBe("/advanced-purchase");
    expect(r.sections.StockReceived).toMatchObject({ lines: 2, withCardId: 1, withoutCardId: 1, qtySum: 10 });
    expect(r.skuDiffs[0]).toMatchObject({ sku: "A", liveOrdered: 10, liveStockReceived: 10, livePutAway: 0, parserWouldStoreReceived: 0, cachedReceived: 0 });
    for (const call of vi.mocked(cin7Request).mock.calls) expect((call[2] as { method?: string } | undefined)?.method ?? "GET").toBe("GET");
  });

  it("reports an API error instead of throwing", async () => {
    vi.mocked(cin7Request).mockImplementation(async () => {
      throw new Error("boom");
    });
    const r = await probePurchaseReceipts(creds, "po2", null);
    expect(r.error).toBe("boom");
  });
});
