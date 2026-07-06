import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllPurchasesList } from "@/cin7/purchases";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllPurchasesList", () => {
  it("requests /purchaseList with capital-case Page/Limit and returns the PurchaseList array", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      PurchaseList: [{ ID: "p1", OrderNumber: "PO-1", CombinedReceivingStatus: "NOT RECEIVED", RequiredBy: "2024-01-01" }],
    });
    const all = await fetchAllPurchasesList(creds);
    expect(all).toEqual([{ ID: "p1", OrderNumber: "PO-1", CombinedReceivingStatus: "NOT RECEIVED", RequiredBy: "2024-01-01" }]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/purchaseList", { query: { Page: 1, Limit: 100 } });
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ID: `p-${i}` }));
    const page2 = [{ ID: "p-last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ PurchaseList: page1 }).mockResolvedValueOnce({ PurchaseList: page2 });
    const all = await fetchAllPurchasesList(creds);
    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});
