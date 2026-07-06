import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllProductionOrdersList } from "@/cin7/production-orders";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllProductionOrdersList", () => {
  it("requests /production/orderList with capital-case Page/Limit and returns the ProductionOrderListItems array (inconsistent key name vs. the request path, confirmed live)", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      ProductionOrderListItems: [{ TaskID: "o1", ProductionOrderID: "o1", Type: "O", OrderNumber: "MO-1", Status: "RELEASED" }],
    });
    const all = await fetchAllProductionOrdersList(creds);
    expect(all).toEqual([{ TaskID: "o1", ProductionOrderID: "o1", Type: "O", OrderNumber: "MO-1", Status: "RELEASED" }]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/production/orderList", { query: { Page: 1, Limit: 100 } });
  });

  it("returns both Type O and R rows unfiltered — callers filter to Type O themselves", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      ProductionOrderListItems: [
        { TaskID: "o1", ProductionOrderID: "o1", Type: "O" },
        { TaskID: "r1", ProductionOrderID: "o1", Type: "R" },
      ],
    });
    const all = await fetchAllProductionOrdersList(creds);
    expect(all).toHaveLength(2);
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ TaskID: `o-${i}` }));
    const page2 = [{ TaskID: "o-last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ ProductionOrderListItems: page1 }).mockResolvedValueOnce({ ProductionOrderListItems: page2 });
    const all = await fetchAllProductionOrdersList(creds);
    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});
