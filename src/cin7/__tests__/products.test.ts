import { describe, expect, it, vi, beforeEach } from "vitest";
import { toCin7ProductPayload, pushProduct, resolveComponentIds } from "@/cin7/products";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };
const product = {
  sku: "SKU1",
  name: "Widget",
  description: null,
  category_code: "Widgets",
  brand: null,
  uom_code: "Item",
  barcode: null,
  active: true,
  status: "Active",
  cin7_type: "Stock",
  costing_method: "FIFO",
  length: null,
  width: null,
  height: null,
  weight: null,
  carton_length: null,
  carton_width: null,
  carton_height: null,
  carton_inner_quantity: null,
  carton_quantity: null,
  weight_units: null,
  dimension_units: null,
  minimum_before_reorder: null,
  reorder_quantity: null,
  default_location: null,
  last_supplied_by: null,
  supplier_product_code: null,
  supplier_product_name: null,
  supplier_fixed_price: null,
  auto_assemble: false,
  auto_disassemble: false,
  drop_ship: null,
  inventory_account: null,
  revenue_account: null,
  expense_account: null,
  cogs_account: null,
  product_attribute_set: null,
  additional_attribute_1: null,
  additional_attribute_2: null,
  additional_attribute_3: null,
  additional_attribute_4: null,
  additional_attribute_5: null,
  additional_attribute_6: null,
  additional_attribute_7: null,
  additional_attribute_8: null,
  additional_attribute_9: null,
  additional_attribute_10: null,
  discount_name: null,
  comma_delimited_tags: null,
  stock_locator: null,
  purchase_tax_rule: null,
  sale_tax_rule: null,
  short_description: null,
  sellable: true,
  pick_zones: null,
  always_show_quantity: null,
  internal_note: null,
  hs_code: null,
  country_of_origin: null,
};

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("toCin7ProductPayload", () => {
  it("maps core fields and Status", () => {
    const payload = toCin7ProductPayload(product);
    expect(payload).toMatchObject({ SKU: "SKU1", Name: "Widget", Category: "Widgets", UOM: "Item", Status: "Active" });
  });

  it("sends Status verbatim, not derived from active — supports Deprecated as the product-level soft-delete", () => {
    const payload = toCin7ProductPayload({ ...product, active: true, status: "Deprecated" });
    expect(payload.Status).toBe("Deprecated");
  });

  it("sends Type and CostingMethod — both required by Cin7 on create", () => {
    const payload = toCin7ProductPayload(product);
    expect(payload.Type).toBe("Stock");
    expect(payload.CostingMethod).toBe("FIFO");
  });

  it("sends Type verbatim, not reverse-mapped from an internal category — avoids collapsing Service into Stock", () => {
    const payload = toCin7ProductPayload({ ...product, cin7_type: "Service" });
    expect(payload.Type).toBe("Service");
  });

  it("sends Brand — previously never modeled at all, so it silently never updated in Cin7", () => {
    const payload = toCin7ProductPayload({ ...product, brand: "Acme" });
    expect(payload.Brand).toBe("Acme");
  });

  it("sends Description — captured on import but never included in the push payload before", () => {
    const payload = toCin7ProductPayload({ ...product, description: "A fine widget." });
    expect(payload.Description).toBe("A fine widget.");
  });

  it("sends supplier data as a Suppliers array, using Cin7's real field names (SupplierInventoryCode, FixedCost)", () => {
    const payload = toCin7ProductPayload({
      ...product,
      last_supplied_by: "Acme Supplies",
      supplier_product_code: "AC-100",
      supplier_product_name: "Acme Widget",
      supplier_fixed_price: 4.5,
    });
    expect(payload.Suppliers).toEqual([
      {
        SupplierName: "Acme Supplies",
        SupplierInventoryCode: "AC-100",
        SupplierProductName: "Acme Widget",
        FixedCost: 4.5,
      },
    ]);
  });

  it("omits Suppliers entirely when there's no supplier data", () => {
    const payload = toCin7ProductPayload(product);
    expect(payload).not.toHaveProperty("Suppliers");
  });

  it("sends the full field set added in the completeness pass, using confirmed live JSON field names", () => {
    const payload = toCin7ProductPayload({
      ...product,
      length: 10,
      width: 5,
      weight_units: "kg",
      dimension_units: "cm",
      auto_assemble: true,
      auto_disassemble: false,
      drop_ship: "No Drop Ship",
      inventory_account: "630",
      product_attribute_set: "Sizes",
      additional_attribute_1: "Red",
      discount_name: "Trade",
      comma_delimited_tags: "new,sale",
      purchase_tax_rule: "Purchases 15%",
      sale_tax_rule: "Sales 15%",
      sellable: true,
      hs_code: "1234.56",
      country_of_origin: "South Africa",
    });
    expect(payload).toMatchObject({
      Length: 10,
      Width: 5,
      WeightUnits: "kg",
      DimensionsUnits: "cm", // Cin7's write-side field differs from the CSV column name (DimensionUnits)
      AutoAssembly: true,
      AutoDisassembly: false,
      DropShipMode: "No Drop Ship",
      InventoryAccount: "630",
      AttributeSet: "Sizes",
      AdditionalAttribute1: "Red",
      DiscountRule: "Trade",
      Tags: "new,sale",
      PurchaseTaxRule: "Purchases 15%",
      SaleTaxRule: "Sales 15%",
      Sellable: true,
      HSCode: "1234.56",
      CountryOfOrigin: "South Africa",
    });
  });

  it("only includes valid Tier1-10 price tiers", () => {
    const payload = toCin7ProductPayload(product, [
      { tier_code: "Tier1", amount: 10 },
      { tier_code: "Tier10", amount: 20 },
      { tier_code: "NotATier", amount: 999 },
    ]);
    expect(payload.PriceTier1).toBe(10);
    expect(payload.PriceTier10).toBe(20);
    expect(payload).not.toHaveProperty("PriceTierNotATier");
  });

  it("defaults PriceTier1 to 0 when the product has no price tiers — Cin7 rejects create with an empty PriceTiers set", () => {
    const payload = toCin7ProductPayload(product, []);
    expect(payload.PriceTier1).toBe(0);
  });
});

const CATEGORY_EXISTS = { CategoryList: [{ ID: "cat-1", Name: "Widgets" }] };
const UOM_EXISTS = { UnitList: [{ ID: "uom-1", Name: "Item" }] };

// `product` has category_code + uom_code set but brand: null, so pushProduct
// checks Category then UOM (Brand is skipped) before every product push.
describe("pushProduct", () => {
  it("creates via POST when the SKU doesn't exist yet", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce(CATEGORY_EXISTS)
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [] }) // findProductBySku
      .mockResolvedValueOnce({ ID: "new-id" }); // create

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "new-id", status: "created" });
    expect(cin7Request).toHaveBeenNthCalledWith(4, creds, "/Product", expect.objectContaining({ method: "POST" }));
  });

  it("updates via PUT when the SKU already exists", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce(CATEGORY_EXISTS)
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [{ ID: "existing-id", SKU: "SKU1" }] })
      .mockResolvedValueOnce({ ID: "existing-id" });

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "existing-id", status: "updated" });
    const [, , options] = vi.mocked(cin7Request).mock.calls[3];
    expect(options).toMatchObject({ method: "PUT", body: expect.objectContaining({ ID: "existing-id" }) });
  });

  it("creates rather than overwrites when the lookup returns a non-matching SKU", async () => {
    // Guards against a filter param Cin7 silently ignores, which would
    // otherwise return an arbitrary product and get PUT-overwritten.
    vi.mocked(cin7Request)
      .mockResolvedValueOnce(CATEGORY_EXISTS)
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [{ ID: "unrelated-id", SKU: "SOME-OTHER-SKU" }] })
      .mockResolvedValueOnce({ ID: "new-id" });

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "new-id", status: "created" });
    expect(cin7Request).toHaveBeenNthCalledWith(4, creds, "/Product", expect.objectContaining({ method: "POST" }));
  });

  it("throws with the raw response instead of silently returning a null cin7Id", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce(CATEGORY_EXISTS)
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [] })
      .mockResolvedValueOnce({ SomeOtherField: "value" } as never);

    await expect(pushProduct(creds, product)).rejects.toThrow(/no ID field[\s\S]*SomeOtherField/);
  });

  it("extracts the ID from a wrapped-list response (confirmed live shape: {Total, Page, Products})", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce(CATEGORY_EXISTS)
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [{ ID: "existing-id", SKU: "SKU1" }] })
      .mockResolvedValueOnce({ Total: 1, Page: 1, Products: [{ ID: "existing-id", SKU: "SKU1" }] } as never);

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "existing-id", status: "updated" });
  });

  it("merges Assembly BOM fields into the same Product push (Cin7 has no separate BOM endpoint)", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [{ ID: "comp-id", SKU: "COMP1" }] }) // resolveComponentIds -> find COMP1
      .mockResolvedValueOnce(CATEGORY_EXISTS)
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [] }) // findProductBySku(SKU1) -> not found
      .mockResolvedValueOnce({ ID: "new-id" }); // create

    const bomLines = [
      {
        product_sku: "SKU1",
        component_sku: "COMP1",
        quantity: 2,
        wastage_quantity: null,
        wastage_percent: null,
        cost_percentage: null,
        price_tier: null,
        expense_account: null,
      },
    ];

    await pushProduct(creds, product, [], bomLines);

    const [, , options] = vi.mocked(cin7Request).mock.calls[4];
    const body = options?.body as { BillOfMaterial: boolean; BillOfMaterialsProducts: unknown[] };
    expect(body.BillOfMaterial).toBe(true);
    expect(body.BillOfMaterialsProducts).toEqual([
      expect.objectContaining({ ComponentProductID: "comp-id", ProductCode: "COMP1", Quantity: 2 }),
    ]);
  });

  it("creates a missing Category before pushing the product — confirmed live: POST/PUT /Product rejects an unrecognized Category", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CategoryList: [] }) // category not found
      .mockResolvedValueOnce({ ID: "cat-new", Name: "Widgets" }) // category created
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [] }) // findProductBySku
      .mockResolvedValueOnce({ ID: "new-id" }); // create

    await pushProduct(creds, product);

    expect(cin7Request).toHaveBeenNthCalledWith(
      2,
      creds,
      "/ref/category",
      expect.objectContaining({ method: "POST", body: { Name: "Widgets" } })
    );
  });

  it("creates a missing Brand before pushing the product — confirmed live: 'Brand ... was not found in reference book'", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce(CATEGORY_EXISTS)
      .mockResolvedValueOnce({ BrandList: [] }) // brand not found
      .mockResolvedValueOnce({ ID: "brand-new", Name: "Acme" }) // brand created
      .mockResolvedValueOnce(UOM_EXISTS)
      .mockResolvedValueOnce({ Products: [] })
      .mockResolvedValueOnce({ ID: "new-id" });

    await pushProduct(creds, { ...product, brand: "Acme" });

    expect(cin7Request).toHaveBeenNthCalledWith(
      3,
      creds,
      "/ref/brand",
      expect.objectContaining({ method: "POST", body: { Name: "Acme" } })
    );
  });

  it("skips the Category/Brand/UOM checks entirely when the product has none of them set", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [] }) // findProductBySku
      .mockResolvedValueOnce({ ID: "new-id" }); // create

    await pushProduct(creds, { ...product, category_code: null, brand: null, uom_code: null });

    expect(cin7Request).toHaveBeenCalledTimes(2);
  });
});

describe("resolveComponentIds", () => {
  it("resolves an unresolved SKU and stores it in the cache", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Products: [{ ID: "comp-id", SKU: "COMP1" }] });
    const cache = new Map<string, string | null | undefined>();

    await resolveComponentIds(creds, ["COMP1"], cache);

    expect(cache.get("COMP1")).toBe("comp-id");
    expect(cin7Request).toHaveBeenCalledTimes(1);
  });

  it("skips a SKU that's already cached (no extra API call)", async () => {
    const cache = new Map<string, string | null | undefined>([["COMP1", "already-resolved"]]);

    await resolveComponentIds(creds, ["COMP1"], cache);

    expect(cin7Request).not.toHaveBeenCalled();
    expect(cache.get("COMP1")).toBe("already-resolved");
  });

  it("leaves a SKU unresolved (no throw) if it doesn't exist in Cin7 yet", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Products: [] });
    const cache = new Map<string, string | null | undefined>();

    await resolveComponentIds(creds, ["NOT-YET-SYNCED"], cache);

    expect(cache.has("NOT-YET-SYNCED")).toBe(false);
  });
});
