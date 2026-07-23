import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllProductsForSupplierPlanning } from "@/cin7/product-supplier-options";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllProductsForSupplierPlanning", () => {
  it("requests /Product with IncludeSuppliers=true and parses ProductSupplierOptions nested in each Suppliers[] entry", async () => {
    // Real shape confirmed live 2026-07-23 against Spark Demo's "New Item for Smart" / "3 Diamonds Transport (Pty) Ltd".
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [
        {
          ID: "18bd8a57-f43c-4c60-af6c-d78dcfbd97d1",
          SKU: "New Item for Smart",
          Name: "New Item for Smart",
          Suppliers: [
            {
              SupplierID: "f3705aa1-332f-4f27-8dbe-6b8a33f3abff",
              SupplierName: "3 Diamonds Transport (Pty) Ltd",
              Cost: 400,
              Currency: "USD",
              ProductSupplierOptions: [
                {
                  LocationID: null,
                  LocationName: null,
                  ReorderQuantity: 500,
                  Lead: 10,
                  Safety: 20,
                  MinimumToReorder: 500,
                },
                {
                  LocationID: "2644da88-a4a3-43c9-b959-988ff68bfaf1",
                  LocationName: "BPM",
                  ReorderQuantity: 500,
                  Lead: 10,
                  Safety: 20,
                  MinimumToReorder: null,
                },
              ],
            },
            {
              SupplierID: "b1e29663-b054-41ea-bb51-be34f5ed8b5f",
              SupplierName: "ABC Suppliers",
              Cost: 300,
              Currency: "ZAR",
              ProductSupplierOptions: [],
            },
          ],
        },
      ],
    });

    const all = await fetchAllProductsForSupplierPlanning(creds);

    expect(all).toEqual([
      {
        productId: "18bd8a57-f43c-4c60-af6c-d78dcfbd97d1",
        sku: "New Item for Smart",
        name: "New Item for Smart",
        suppliers: [
          {
            supplierId: "f3705aa1-332f-4f27-8dbe-6b8a33f3abff",
            supplierName: "3 Diamonds Transport (Pty) Ltd",
            cost: 400,
            currency: "USD",
            options: [
              { locationId: null, locationName: null, reorderQuantity: 500, lead: 10, safety: 20, minimumToReorder: 500 },
              { locationId: "2644da88-a4a3-43c9-b959-988ff68bfaf1", locationName: "BPM", reorderQuantity: 500, lead: 10, safety: 20, minimumToReorder: null },
            ],
          },
          {
            supplierId: "b1e29663-b054-41ea-bb51-be34f5ed8b5f",
            supplierName: "ABC Suppliers",
            cost: 300,
            currency: "ZAR",
            options: [],
          },
        ],
      },
    ]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { query: { page: 1, limit: 100, IncludeSuppliers: "true" } });
  });

  it("defaults suppliers/options to an empty array when absent", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Products: [{ SKU: "NOSUP", Name: "No Supplier" }] });
    const all = await fetchAllProductsForSupplierPlanning(creds);
    expect(all[0].suppliers).toEqual([]);
  });

  it("defaults currency to null when blank/absent", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [{ SKU: "NOCUR", Name: "No Currency", Suppliers: [{ SupplierID: "s1", SupplierName: "Test Supplier", Cost: null, Currency: "" }] }],
    });
    const all = await fetchAllProductsForSupplierPlanning(creds);
    expect(all[0].suppliers[0].currency).toBeNull();
    expect(all[0].suppliers[0].cost).toBeNull();
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ SKU: `sku-${i}`, Name: `p${i}` }));
    const page2 = [{ SKU: "sku-last", Name: "last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ Products: page1 }).mockResolvedValueOnce({ Products: page2 });
    const all = await fetchAllProductsForSupplierPlanning(creds);
    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});
