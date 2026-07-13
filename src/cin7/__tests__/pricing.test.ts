import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchAllProductsForPricing } from "@/cin7/pricing";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

function tierFields(values: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  values.forEach((v, i) => (out[`PriceTier${i + 1}`] = v));
  return out;
}

const NAMED_TIERS = {
  "Retail in VAT": 87.72,
  "Retail ex VAT": 0,
  Wholesale: 0,
  "Wholesale 2": 0,
  USD: 0,
  "Staff Pricing": 0,
  "Tier 7": 0,
  "Tier 8": 0,
  "Tier 9": 0,
  "Tier 10": 0,
};

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("fetchAllProductsForPricing", () => {
  it("requests /Product with page/limit and IncludeSuppliers=true, and parses category/suppliers/price tiers", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [
        {
          ID: "prod-1",
          SKU: "WIDGET",
          Name: "Widget",
          Category: "Apparel",
          Suppliers: [{ SupplierName: "Acme Supplies" }],
          ...tierFields([87.72, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          PriceTiers: NAMED_TIERS,
        },
      ],
    });

    const result = await fetchAllProductsForPricing(creds);

    expect(result.products).toEqual([
      {
        productId: "prod-1",
        sku: "WIDGET",
        name: "Widget",
        category: "Apparel",
        supplierNames: ["Acme Supplies"],
        priceTierValues: [87.72, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ]);
    expect(result.tierLabels).toEqual(Object.keys(NAMED_TIERS));
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { query: { page: 1, limit: 100, IncludeSuppliers: "true" } });
  });

  it("defaults category to null and supplierNames to an empty array when absent", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [{ ID: "prod-2", SKU: "NOCAT", Name: "No Category", ...tierFields([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), PriceTiers: NAMED_TIERS }],
    });
    const result = await fetchAllProductsForPricing(creds);
    expect(result.products[0].category).toBeNull();
    expect(result.products[0].supplierNames).toEqual([]);
  });

  it("falls back to generic 'Tier N' labels when a product has no PriceTiers object", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      Products: [{ ID: "prod-3", SKU: "WIDGET", Name: "Widget", ...tierFields([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }],
    });
    const result = await fetchAllProductsForPricing(creds);
    expect(result.tierLabels).toEqual(["Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5", "Tier 6", "Tier 7", "Tier 8", "Tier 9", "Tier 10"]);
  });

  it("paginates until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ID: `id-${i}`, SKU: `sku-${i}`, Name: `p${i}`, ...tierFields([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }));
    const page2 = [{ ID: "id-last", SKU: "sku-last", Name: "last", ...tierFields([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }];
    vi.mocked(cin7Request).mockResolvedValueOnce({ Products: page1 }).mockResolvedValueOnce({ Products: page2 });
    const result = await fetchAllProductsForPricing(creds);
    expect(result.products).toHaveLength(101);
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});
