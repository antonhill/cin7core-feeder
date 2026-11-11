import { describe, expect, it, vi, beforeEach } from "vitest";
import { probePurchaseReceipts } from "@/cin7/purchase-receipt-probe";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});
const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };
beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

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

  it("simulates the sync's receipt PK: duplicate (CardID, SKU) lines would roll back the whole PO", async () => {
    vi.mocked(cin7Request).mockImplementation(async () => ({
      Order: { Lines: [{ SKU: "A", Quantity: 5 }, { SKU: "B", Quantity: 1 }] },
      StockReceived: { Status: "AUTHORISED", Lines: [{ CardID: "card-12345678", SKU: "A", Quantity: 2 }, { CardID: "card-12345678", SKU: "A", Quantity: 3 }, { CardID: "card-12345678", SKU: "B", Quantity: 1 }] },
    }));
    const r = await probePurchaseReceipts(creds, "po3", null);
    expect(r.parser).toMatchObject({ receiptRows: 3, wouldViolateReceiptPk: true, orderRows: 2 });
    expect(r.parser?.duplicateReceiptKeys).toHaveLength(1);
    expect(r.parser?.invalidDateReceiptRows).toBe(0);
    expect(r.keyShapes?.StockReceived).toContain("Lines:array(3)");
    expect(r.keyShapes?.Order).toContain("Lines:array(2)");
    expect(r.parser?.duplicateReceiptKeys[0]).toMatchObject({ count: 2, quantities: [2, 3] });
    expect(r.sectionEvents?.StockReceived?.[0]).toMatchObject({ Status: "AUTHORISED" });
  });

  it("looks the PO up in /purchaseList (GET) and compares LastUpdatedDate with the latest detail date", async () => {
    vi.mocked(cin7Request).mockImplementation(async (_c, path) => {
      if (path === "/purchaseList") return { PurchaseList: [{ ID: "po4", LastUpdatedDate: "2026-07-02T10:00:00", Status: "RECEIVING", Supplier: "Hidden" }] };
      return { Order: { Lines: [{ SKU: "A", Quantity: 1 }] }, StockReceived: { Lines: [{ CardID: "c1", SKU: "A", Quantity: 1, Date: "2026-07-01T00:00:00" }] } };
    });
    const r = await probePurchaseReceipts(creds, "po4", null, "PO-4");
    expect(r.listEntry).toMatchObject({ LastUpdatedDate: "2026-07-02T10:00:00", Status: "RECEIVING" });
    expect(r.listEntry).not.toHaveProperty("Supplier");
    expect(r.lastUpdated).toMatchObject({ latestReceivingDate: "2026-07-01T00:00:00", listCoversLatestReceivingDate: true });
    for (const call of vi.mocked(cin7Request).mock.calls) expect((call[2] as { method?: string } | undefined)?.method ?? "GET").toBe("GET");
  });

  it("uses ACTUAL receiving dates only: an invoice due date later than LastUpdatedDate must not affect the comparison", async () => {
    vi.mocked(cin7Request).mockImplementation(async (_c, path) => {
      if (path === "/purchaseList") return { PurchaseList: [{ ID: "po5", LastUpdatedDate: "2026-07-02T10:00:00" }] };
      return {
        Order: { Lines: [{ SKU: "A", Quantity: 2 }] },
        StockReceived: { Lines: [{ CardID: "c1", SKU: "A", Quantity: 1, Date: "2026-07-01T00:00:00" }] },
        Invoice: { DueDate: "2026-12-31T00:00:00", InvoiceDate: "2026-12-01T00:00:00", Lines: [{ SKU: "A", Quantity: 2, Date: "2026-12-31T00:00:00" }] },
      };
    });
    const r = await probePurchaseReceipts(creds, "po5", { ordered: new Map([["A", 2]]), received: new Map([["A", 1]]) }, "PO-5");
    expect(r.lastUpdated).toMatchObject({ latestReceivingDate: "2026-07-01T00:00:00", listCoversLatestReceivingDate: true });
    expect(r.receivedTotals).toEqual({ cached: 1, liveStockReceived: 1, livePutAway: 0 });
  });
});
