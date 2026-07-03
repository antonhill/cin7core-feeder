import { describe, expect, it, vi, beforeEach } from "vitest";
import { toCin7BomPayload, pushAssemblyBoms, type CanonicalAssemblyBomLineRow } from "@/cin7/assembly-bom";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

function line(overrides: Partial<CanonicalAssemblyBomLineRow>): CanonicalAssemblyBomLineRow {
  return {
    product_sku: "PARENT",
    component_sku: "COMP",
    quantity: 1,
    wastage_quantity: null,
    wastage_percent: null,
    cost_percentage: null,
    price_tier: null,
    expense_account: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("toCin7BomPayload", () => {
  it("classifies a stock line as a BOMComponent", () => {
    const payload = toCin7BomPayload("PARENT", [line({ component_sku: "COMP", quantity: 2 })]);
    expect(payload.BOMComponents).toEqual([
      expect.objectContaining({ ComponentSKU: "COMP", Quantity: 2 }),
    ]);
    expect(payload.BOMServices).toHaveLength(0);
  });

  it("classifies a line with a PriceTier/ExpenseAccount as a BOMService", () => {
    const payload = toCin7BomPayload("PARENT", [
      line({ component_sku: "LAB-001", price_tier: "Retail", expense_account: "260: COGS" }),
    ]);
    expect(payload.BOMServices).toEqual([
      expect.objectContaining({ ServiceName: "LAB-001", PriceTier: "Retail", ExpenseAccount: "260: COGS" }),
    ]);
    expect(payload.BOMComponents).toHaveLength(0);
  });
});

describe("pushAssemblyBoms", () => {
  it("sends one batch for <=100 products and reports success", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      BillOfMaterialsList: [{ SKU: "P1", OperationStatus: "Succeeded" }],
    });

    const results = await pushAssemblyBoms(creds, new Map([["P1", [line({ product_sku: "P1" })]]]));

    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ productSku: "P1", ok: true, error: undefined }]);
  });

  it("splits into multiple batches of 100", async () => {
    vi.mocked(cin7Request).mockResolvedValue({ BillOfMaterialsList: [] });
    const linesByProduct = new Map<string, CanonicalAssemblyBomLineRow[]>(
      Array.from({ length: 150 }, (_, i) => [`P${i}`, [line({ product_sku: `P${i}` })]])
    );

    await pushAssemblyBoms(creds, linesByProduct);

    expect(cin7Request).toHaveBeenCalledTimes(2);
    const firstBody = vi.mocked(cin7Request).mock.calls[0][2]?.body as unknown[];
    const secondBody = vi.mocked(cin7Request).mock.calls[1][2]?.body as unknown[];
    expect(firstBody).toHaveLength(100);
    expect(secondBody).toHaveLength(50);
  });

  it("reports a failed product from OperationStatus", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      BillOfMaterialsList: [{ SKU: "P1", OperationStatus: "Failed", Errors: ["ComponentSKU not found"] }],
    });

    const results = await pushAssemblyBoms(creds, new Map([["P1", [line({ product_sku: "P1" })]]]));

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("ComponentSKU not found");
  });
});
