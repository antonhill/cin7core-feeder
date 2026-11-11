import { describe, expect, it, vi } from "vitest";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

/**
 * CHARACTERISATION of two known receipt-ingest behaviours that affect the PO
 * Quantity Comparison report. These pin CURRENT behaviour (they are not
 * endorsements); a repair PR should change the assertions deliberately.
 *
 * 1. purchase_receipt_lines' PK is (org, instance, card_id, product_sku)
 *    (migration 0025). If one receiving batch (CardID) holds two lines for
 *    the SAME SKU, the parser hands both through, and
 *    replace_purchase_detail's insert would violate the PK — rolling back the
 *    whole PO detail (it stays detail_synced_at = null, retried every run).
 *    The report therefore shows that PO as "incomplete", never wrong.
 * 2. Receipt lines without a CardID are dropped silently by the parser. That
 *    UNDER-COUNTS received quantity on an otherwise successfully synced PO,
 *    and the report cannot detect it.
 */
describe("receipt ingest characterisation", () => {
  it("emits two rows with the same (cardId, sku) key for a duplicate-SKU batch", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: {
        Lines: [
          { CardID: "card-1", SKU: "SKU-A", Name: "W", Quantity: 3, Date: "2026-01-30T00:00:00" },
          { CardID: "card-1", SKU: "SKU-A", Name: "W", Quantity: 4, Date: "2026-01-30T00:00:00" },
        ],
      },
    });
    const { receiptLines } = await fetchPurchaseDetail(creds, "po-dup");
    const keys = receiptLines.map((l) => `${l.cardId}|${l.productSku}`);
    expect(keys).toEqual(["card-1|SKU-A", "card-1|SKU-A"]);
    expect(new Set(keys).size).toBeLessThan(keys.length); // would violate the 0025 primary key
  });

  it("silently drops receipt lines that have no CardID", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: {
        Lines: [
          { CardID: "card-1", SKU: "SKU-A", Name: "W", Quantity: 3 },
          { SKU: "SKU-A", Name: "W", Quantity: 4 },
        ],
      },
    });
    const { receiptLines } = await fetchPurchaseDetail(creds, "po-nocard");
    expect(receiptLines.reduce((s, l) => s + l.quantity, 0)).toBe(3); // 4 units vanished
  });
});
