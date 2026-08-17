import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPurchaseOrder } from "@/cin7/purchase-write";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("createPurchaseOrder", () => {
  it("posts both the header and the order-lines call with nonIdempotentCreate: true — security re-audit P0-2: neither creates a real Cin7 record with a client-supplied reference, so neither may be auto-retried on a network failure", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ ID: "task-1", OrderNumber: "PO-001", Status: "DRAFT" })
      .mockResolvedValueOnce({ Lines: [{ SKU: "WIDGET" }] });

    const result = await createPurchaseOrder(creds, {
      supplierName: "Acme",
      supplierId: "sup-1",
      locationName: "Main Warehouse",
      locationId: "loc-1",
      lines: [{ productId: "prod-1", sku: "WIDGET", name: "Widget", quantity: 2, price: 10 }],
    });

    expect(result).toEqual({ taskId: "task-1", orderNumber: "PO-001", status: "DRAFT", lineCount: 1 });

    expect(cin7Request).toHaveBeenNthCalledWith(
      1,
      creds,
      "/purchase",
      expect.objectContaining({ method: "POST", nonIdempotentCreate: true })
    );
    expect(cin7Request).toHaveBeenNthCalledWith(
      2,
      creds,
      "/purchase/order",
      expect.objectContaining({ method: "POST", nonIdempotentCreate: true })
    );
  });
});
