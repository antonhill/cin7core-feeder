import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllProductsForReplenish } from "@/cin7/product-reorder";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllProductsForReplenish", () => {
  it("requests /Product with page/limit and IncludeReorderLevels=true, and parses ReorderLevels entries", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [
        {
          ID: "prod-1",
          SKU: "WIDGET",
          Name: "Widget",
          Category: "Apparel",
          Brand: "Acme",
          MinimumBeforeReorder: 5,
          ReorderQuantity: 20,
          ReorderLevels: [
            {
              LocationID: "loc-1",
              LocationName: "Main Warehouse",
              MinimumBeforeReorder: 10,
              ReorderQuantity: 50,
              StockLocator: "Aisle 3",
              PickZones: "A,B",
            },
          ],
        },
      ],
    });

    const all = await fetchAllProductsForReplenish(creds);

    expect(all).toEqual([
      {
        productId: "prod-1",
        sku: "WIDGET",
        name: "Widget",
        category: "Apparel",
        brand: "Acme",
        minimumBeforeReorder: 5,
        reorderQuantity: 20,
        reorderLevels: [
          {
            locationId: "loc-1",
            locationName: "Main Warehouse",
            minimumBeforeReorder: 10,
            reorderQuantity: 50,
            stockLocator: "Aisle 3",
            pickZones: "A,B",
          },
        ],
      },
    ]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { query: { page: 1, limit: 100, IncludeReorderLevels: "true" } });
  });

  it("defaults category/brand to null and stockLocator/pickZones to null when absent", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [
        {
          ID: "prod-2",
          SKU: "NOCAT",
          Name: "No Category",
          ReorderLevels: [{ LocationID: "loc-1", LocationName: "Main Warehouse", MinimumBeforeReorder: 10, ReorderQuantity: 50 }],
        },
      ],
    });
    const all = await fetchAllProductsForReplenish(creds);
    expect(all[0].category).toBeNull();
    expect(all[0].brand).toBeNull();
    expect(all[0].reorderLevels[0].stockLocator).toBeNull();
    expect(all[0].reorderLevels[0].pickZones).toBeNull();
  });

  it("defaults reorderLevels to an empty array when the field is missing or empty", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [{ SKU: "NOLEVELS", Name: "No Levels", MinimumBeforeReorder: 0, ReorderQuantity: 0, ReorderLevels: [] }],
    });
    const all = await fetchAllProductsForReplenish(creds);
    expect(all[0].reorderLevels).toEqual([]);
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ SKU: `sku-${i}`, Name: `p${i}` }));
    const page2 = [{ SKU: "sku-last", Name: "last" }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ Products: page1 }).mockResolvedValueOnce({ Products: page2 });
    const all = await fetchAllProductsForReplenish(creds);
    expect(all).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});
