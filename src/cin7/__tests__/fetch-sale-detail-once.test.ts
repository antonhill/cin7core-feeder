import { describe, expect, it, vi } from "vitest";

vi.mock("../http", () => ({ cin7Request: vi.fn(() => Promise.resolve({ ID: "s" })) }));
import { cin7Request } from "../http";
import { fetchSaleDetail, fetchSaleDetailOnce } from "../sales";

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://x" };
describe("fetchSaleDetailOnce", () => {
  it("is the same GET /sale?ID= as fetchSaleDetail but with maxRetries 0 and no method (so no write)", async () => {
    await fetchSaleDetailOnce(creds, "sale-1");
    expect(cin7Request).toHaveBeenCalledWith(creds, "/sale", { query: { ID: "sale-1" }, maxRetries: 0 });
  });
  it("the ordinary reader is unchanged (default retries)", async () => {
    vi.mocked(cin7Request).mockClear();
    await fetchSaleDetail(creds, "sale-1");
    expect(cin7Request).toHaveBeenCalledWith(creds, "/sale", { query: { ID: "sale-1" } });
  });
});
