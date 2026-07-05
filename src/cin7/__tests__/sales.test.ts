import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchInvoicedSalesList, fetchSaleDetail } from "@/cin7/sales";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchInvoicedSalesList", () => {
  it("filters by CombinedInvoiceStatus=AUTHORISED and paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ SaleID: `sale-${i}` }));
    const page2 = [{ SaleID: "sale-last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: page1 }).mockResolvedValueOnce({ SaleList: page2 });

    const all = await fetchInvoicedSalesList(creds);

    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
    expect(cin7Request).toHaveBeenNthCalledWith(1, creds, "/saleList", {
      query: { Page: 1, Limit: 100, CombinedInvoiceStatus: "AUTHORISED" },
    });
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/saleList", {
      query: { Page: 2, Limit: 100, CombinedInvoiceStatus: "AUTHORISED" },
    });
  });

  it("includes UpdatedSince when provided, for incremental sync", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [] });
    await fetchInvoicedSalesList(creds, "2026-01-01T00:00:00.000Z");
    expect(cin7Request).toHaveBeenCalledWith(creds, "/saleList", {
      query: { Page: 1, Limit: 100, CombinedInvoiceStatus: "AUTHORISED", UpdatedSince: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("omits UpdatedSince entirely when not provided — first-run backfill", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [] });
    await fetchInvoicedSalesList(creds);
    const [, , options] = vi.mocked(cin7Request).mock.calls[0];
    expect(options).not.toHaveProperty("query.UpdatedSince");
    expect((options as { query: Record<string, unknown> }).query.UpdatedSince).toBeUndefined();
  });
});

describe("fetchSaleDetail", () => {
  it("requests /sale by ID", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "sale-1", Invoices: [] });
    const detail = await fetchSaleDetail(creds, "sale-1");
    expect(detail).toEqual({ ID: "sale-1", Invoices: [] });
    expect(cin7Request).toHaveBeenCalledWith(creds, "/sale", { query: { ID: "sale-1" } });
  });
});
