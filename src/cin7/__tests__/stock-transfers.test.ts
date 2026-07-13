import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllStockTransfersList, createStockTransfer } from "@/cin7/stock-transfers";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllStockTransfersList", () => {
  it("requests /stockTransferList with capital-case Page/Limit and returns the StockTransferList array", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      StockTransferList: [{ TaskID: "t1", Number: "TR-1", Status: "ORDERED" }],
    });
    const all = await fetchAllStockTransfersList(creds);
    expect(all).toEqual([{ TaskID: "t1", Number: "TR-1", Status: "ORDERED" }]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/stockTransferList", { query: { Page: 1, Limit: 100 } });
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ TaskID: `t-${i}` }));
    const page2 = [{ TaskID: "t-last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ StockTransferList: page1 }).mockResolvedValueOnce({ StockTransferList: page2 });
    const all = await fetchAllStockTransfersList(creds);
    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});

describe("createStockTransfer", () => {
  it("posts Status: DRAFT with plain location name strings and one line per SKU", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ TaskID: "task-1", Number: "TR-00065", Status: "DRAFT" });

    const result = await createStockTransfer(creds, "Main Warehouse", "Head Office", [
      { sku: "WIDGET", transferQuantity: 3 },
    ]);

    expect(result).toEqual({ taskId: "task-1", number: "TR-00065", status: "DRAFT" });
    expect(cin7Request).toHaveBeenCalledWith(creds, "/stockTransfer", {
      method: "POST",
      body: {
        Status: "DRAFT",
        FromLocation: "Main Warehouse",
        ToLocation: "Head Office",
        Lines: [{ SKU: "WIDGET", TransferQuantity: 3 }],
      },
    });
  });

  it("includes BatchSN/ExpiryDate on a line only when both are provided", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ TaskID: "task-2", Number: "TR-00066", Status: "DRAFT" });

    await createStockTransfer(creds, "Main Warehouse", "Head Office", [
      { sku: "AFRICOLOGYTEST", transferQuantity: 1, batchSn: "TestBatch2", expiryDate: "2027-04-13" },
    ]);

    expect(cin7Request).toHaveBeenCalledWith(creds, "/stockTransfer", {
      method: "POST",
      body: {
        Status: "DRAFT",
        FromLocation: "Main Warehouse",
        ToLocation: "Head Office",
        Lines: [{ SKU: "AFRICOLOGYTEST", TransferQuantity: 1, BatchSN: "TestBatch2", ExpiryDate: "2027-04-13" }],
      },
    });
  });

  it("omits BatchSN/ExpiryDate for a line where they're null (non-tracked stock)", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ TaskID: "task-3", Number: "TR-00067", Status: "DRAFT" });

    await createStockTransfer(creds, "Main Warehouse", "Head Office", [
      { sku: "WIDGET", transferQuantity: 5, batchSn: null, expiryDate: null },
    ]);

    expect(cin7Request).toHaveBeenCalledWith(creds, "/stockTransfer", {
      method: "POST",
      body: {
        Status: "DRAFT",
        FromLocation: "Main Warehouse",
        ToLocation: "Head Office",
        Lines: [{ SKU: "WIDGET", TransferQuantity: 5 }],
      },
    });
  });
});
