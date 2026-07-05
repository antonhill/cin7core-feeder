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
  it("does not send a CombinedInvoiceStatus query param — /saleList only accepts one exact value, but several count as 'invoiced'", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [] });
    await fetchInvoicedSalesList(creds);
    const [, , options] = vi.mocked(cin7Request).mock.calls[0];
    expect((options as { query: Record<string, unknown> }).query).not.toHaveProperty("CombinedInvoiceStatus");
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ SaleID: `sale-${i}`, CombinedInvoiceStatus: "INVOICED" }));
    const page2 = [{ SaleID: "sale-last", CombinedInvoiceStatus: "INVOICED" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: page1 }).mockResolvedValueOnce({ SaleList: page2 });

    const all = await fetchInvoicedSalesList(creds);

    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
    expect(cin7Request).toHaveBeenNthCalledWith(1, creds, "/saleList", { query: { Page: 1, Limit: 100 } });
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/saleList", { query: { Page: 2, Limit: 100 } });
  });

  it("keeps INVOICED, INVOICED / CREDITED and PARTIALLY INVOICED — confirmed live as the real values meaning 'has an invoice'", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      SaleList: [
        { SaleID: "s1", CombinedInvoiceStatus: "INVOICED" },
        { SaleID: "s2", CombinedInvoiceStatus: "INVOICED / CREDITED" },
        { SaleID: "s3", CombinedInvoiceStatus: "PARTIALLY INVOICED" },
      ],
    });
    const all = await fetchInvoicedSalesList(creds);
    expect(all.map((s) => s.SaleID)).toEqual(["s1", "s2", "s3"]);
  });

  it("drops NOT INVOICED and NOT AVAILABLE — confirmed these are real values on a live account, not documented ones", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      SaleList: [
        { SaleID: "s1", CombinedInvoiceStatus: "NOT INVOICED" },
        { SaleID: "s2", CombinedInvoiceStatus: "NOT AVAILABLE" },
      ],
    });
    const all = await fetchInvoicedSalesList(creds);
    expect(all).toEqual([]);
  });

  it("includes UpdatedSince when provided, for incremental sync", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [] });
    await fetchInvoicedSalesList(creds, "2026-01-01T00:00:00.000Z");
    expect(cin7Request).toHaveBeenCalledWith(creds, "/saleList", {
      query: { Page: 1, Limit: 100, UpdatedSince: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("omits UpdatedSince entirely when not provided — first-run backfill", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [] });
    await fetchInvoicedSalesList(creds);
    const [, , options] = vi.mocked(cin7Request).mock.calls[0];
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
