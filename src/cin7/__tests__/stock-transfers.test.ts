import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllStockTransfersList } from "@/cin7/stock-transfers";
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
