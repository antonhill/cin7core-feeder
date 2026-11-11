import { describe, expect, it, vi } from "vitest";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

/**
 * CHARACTERISATION of receipt-ingest behaviours that matter to the PO Quantity
 * Comparison report. They pin CURRENT behaviour (not endorsements); a repair PR
 * should change the assertions deliberately.
 *
 * 1. (Fixed by #204) lines sharing a (CardID, SKU) within one PO are now summed
 *    before the insert — see purchase-detail.test.ts.
 * 2. Cin7 can return the NIL CardID (all zeros) on receipt lines. The parser
 *    keeps it as an ordinary string, so such lines from DIFFERENT POs share the
 *    key (nil, SKU). While purchase_receipt_lines is keyed without the PO, the
 *    second PO to carry the same SKU on the nil card cannot be stored (confirmed
 *    live: 10 Lights by Linea POs failing on purchase_receipt_lines_pkey).
 * 3. Receipt lines without any CardID are dropped silently by the parser. That
 *    UNDER-COUNTS received quantity on an otherwise successfully synced PO, and
 *    the report cannot detect it.
 */
describe("receipt ingest characterisation", () => {
  it("keeps a nil CardID as an ordinary key part (the cross-PO collision source), and still aggregates within the PO", async () => {
    const nil = "00000000-0000-0000-0000-000000000000";
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockReceived: {
        Lines: [
          { CardID: nil, SKU: "SKU-A", Name: "W", Quantity: 3, Date: "2026-01-30T00:00:00" },
          { CardID: nil, SKU: "SKU-A", Name: "W", Quantity: 4, Date: "2026-01-30T00:00:00" },
        ],
      },
    });
    const { receiptLines } = await fetchPurchaseDetail(creds, "po-nil");
    expect(receiptLines).toEqual([expect.objectContaining({ cardId: nil, productSku: "SKU-A", quantity: 7 })]);
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
