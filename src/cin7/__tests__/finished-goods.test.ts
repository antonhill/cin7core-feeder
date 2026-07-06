import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllFinishedGoodsList } from "@/cin7/finished-goods";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllFinishedGoodsList", () => {
  it("requests /finishedGoodsList with capital-case Page/Limit and returns the FinishedGoods array", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      FinishedGoods: [{ TaskID: "f1", AssemblyNumber: "FG-1", Status: "DRAFT" }],
    });
    const all = await fetchAllFinishedGoodsList(creds);
    expect(all).toEqual([{ TaskID: "f1", AssemblyNumber: "FG-1", Status: "DRAFT" }]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/finishedGoodsList", { query: { Page: 1, Limit: 100 } });
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ TaskID: `f-${i}` }));
    const page2 = [{ TaskID: "f-last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ FinishedGoods: page1 }).mockResolvedValueOnce({ FinishedGoods: page2 });
    const all = await fetchAllFinishedGoodsList(creds);
    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});
