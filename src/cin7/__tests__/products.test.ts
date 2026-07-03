import { describe, expect, it, vi, beforeEach } from "vitest";
import { toCin7ProductPayload, pushProduct } from "@/cin7/products";
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
};

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("toCin7ProductPayload", () => {
  it("maps core fields and Status", () => {
    const payload = toCin7ProductPayload(product);
    expect(payload).toMatchObject({ SKU: "SKU1", Name: "Widget", Category: "Widgets", UOM: "Item", Status: "Active" });
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
      .mockResolvedValueOnce({ Products: [{ ID: "existing-id" }] })
      .mockResolvedValueOnce({ ID: "existing-id" });

    const result = await pushProduct(creds, product);

    expect(result).toEqual({ cin7Id: "existing-id", status: "updated" });
    const [, , options] = vi.mocked(cin7Request).mock.calls[1];
    expect(options).toMatchObject({ method: "PUT", body: expect.objectContaining({ ID: "existing-id" }) });
  });
});
