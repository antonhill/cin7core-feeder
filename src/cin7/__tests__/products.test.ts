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
  uom_code: "Item",
  barcode: null,
  active: true,
  status: "Active",
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
});

describe("pushProduct", () => {
  it("creates via POST when the SKU doesn't exist yet", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [] }) // findProductBySku
      .mockResolvedValueOnce({ ID: "new-id" }); // create

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "new-id", status: "created" });
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/Product", expect.objectContaining({ method: "POST" }));
  });

  it("updates via PUT when the SKU already exists", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [{ ID: "existing-id", SKU: "SKU1" }] })
      .mockResolvedValueOnce({ ID: "existing-id" });

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "existing-id", status: "updated" });
    const [, , options] = vi.mocked(cin7Request).mock.calls[1];
    expect(options).toMatchObject({ method: "PUT", body: expect.objectContaining({ ID: "existing-id" }) });
  });

  it("creates rather than overwrites when the lookup returns a non-matching SKU", async () => {
    // Guards against a filter param Cin7 silently ignores, which would
    // otherwise return an arbitrary product and get PUT-overwritten.
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [{ ID: "unrelated-id", SKU: "SOME-OTHER-SKU" }] })
      .mockResolvedValueOnce({ ID: "new-id" });

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "new-id", status: "created" });
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/Product", expect.objectContaining({ method: "POST" }));
  });

  it("throws with the raw response instead of silently returning a null cin7Id", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [] })
      .mockResolvedValueOnce({ SomeOtherField: "value" } as never);

    await expect(pushProduct(creds, product)).rejects.toThrow(/no ID field[\s\S]*SomeOtherField/);
  });

  it("extracts the ID from a wrapped-list response (confirmed live shape: {Total, Page, Products})", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [{ ID: "existing-id", SKU: "SKU1" }] })
      .mockResolvedValueOnce({ Total: 1, Page: 1, Products: [{ ID: "existing-id", SKU: "SKU1" }] } as never);

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "existing-id", status: "updated" });
  });

  it("merges Assembly BOM fields into the same Product push (Cin7 has no separate BOM endpoint)", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Products: [{ ID: "comp-id", SKU: "COMP1" }] }) // resolveComponentIds -> find COMP1
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

    const [, , options] = vi.mocked(cin7Request).mock.calls[2];
    const body = options?.body as { BillOfMaterial: boolean; BillOfMaterialsProducts: unknown[] };
    expect(body.BillOfMaterial).toBe(true);
    expect(body.BillOfMaterialsProducts).toEqual([
      expect.objectContaining({ ComponentProductID: "comp-id", ProductCode: "COMP1", Quantity: 2 }),
    ]);
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
