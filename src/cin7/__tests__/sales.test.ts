import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllSalesList, fetchSaleDetail } from "@/cin7/sales";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllSalesList", () => {
  it("returns every sale regardless of invoice status — unfiltered, since the Order Fulfillment Dashboard needs pre-invoice orders too", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      SaleList: [
        { SaleID: "s1", CombinedInvoiceStatus: "NOT INVOICED", FulFilmentStatus: "NOT FULFILLED" },
        { SaleID: "s2", CombinedInvoiceStatus: "INVOICED", FulFilmentStatus: "FULFILLED" },
      ],
    });
    const all = await fetchAllSalesList(creds);
    expect(all.map((s) => s.SaleID)).toEqual(["s1", "s2"]);
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ SaleID: `sale-${i}` }));
    const page2 = [{ SaleID: "sale-last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: page1 }).mockResolvedValueOnce({ SaleList: page2 });
    const all = await fetchAllSalesList(creds);
    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenNthCalledWith(1, creds, "/saleList", { query: { Page: 1, Limit: 100 } });
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/saleList", { query: { Page: 2, Limit: 100 } });
  });

  it("includes UpdatedSince when provided, for incremental sync", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [] });
    await fetchAllSalesList(creds, "2026-01-01T00:00:00.000Z");
    expect(cin7Request).toHaveBeenCalledWith(creds, "/saleList", {
      query: { Page: 1, Limit: 100, UpdatedSince: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("omits UpdatedSince entirely when not provided — first-run backfill", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [] });
    await fetchAllSalesList(creds);
    const [, , options] = vi.mocked(cin7Request).mock.calls[0];
    expect((options as { query: Record<string, unknown> }).query.UpdatedSince).toBeUndefined();
  });

  it("passes through the Order Fulfillment Dashboard's confirmed-live fields (Combined statuses, PaidAmount, Carrier, etc.)", async () => {
    const entry = {
      SaleID: "s1",
      OrderStatus: "AUTHORISED",
      CombinedPickingStatus: "PICKED",
      CombinedPackingStatus: "NOT PACKED",
      CombinedShippingStatus: "NOT SHIPPED",
      CombinedPaymentStatus: "UNPAID",
      CombinedTrackingNumbers: "",
      Carrier: "",
      PaidAmount: 0,
      SaleInvoicesTotalAmount: 4608.04,
    };
    vi.mocked(cin7Request).mockResolvedValueOnce({ SaleList: [entry] });
    const all = await fetchAllSalesList(creds);
    expect(all[0]).toEqual(entry);
  });
});

describe("fetchSaleDetail", () => {
  it("requests /sale by ID", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "sale-1", Invoices: [] });
    const detail = await fetchSaleDetail(creds, "sale-1");
    expect(detail).toEqual({ ID: "sale-1", Invoices: [] });
    expect(cin7Request).toHaveBeenCalledWith(creds, "/sale", { query: { ID: "sale-1" } });
  });

  it("passes through Order.Lines[] (with BackorderQuantity) and Fulfilments[] (with Pick/Pack lines) when present", async () => {
    const raw = {
      ID: "sale-1",
      Invoices: [],
      Order: { SaleOrderNumber: "SO-1", Lines: [{ SKU: "SKU-A", Name: "Widget", Quantity: 2, BackorderQuantity: 1 }] },
      Fulfilments: [
        {
          TaskID: "f1",
          FulFilmentStatus: "NOT FULFILLED",
          Pick: { Status: "AUTHORISED", Lines: [{ SKU: "SKU-A", Name: "Widget", Quantity: 1 }] },
          Pack: { Status: "NOT AVAILABLE", Lines: [] },
        },
      ],
    };
    vi.mocked(cin7Request).mockResolvedValueOnce(raw);
    const detail = await fetchSaleDetail(creds, "sale-1");
    expect(detail).toEqual(raw);
  });
});
