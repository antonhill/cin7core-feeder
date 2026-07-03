import { describe, expect, it, vi, beforeEach } from "vitest";
import { toCin7ProductionBomPayload, pushProductionBom } from "@/cin7/production-bom";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };
const cin7ProductId = "cin7-product-guid";
const version = { product_sku: "FACEBULK001", version: "1", version_name: null, quantity_to_produce: 1000 };
const operations = [
  { operation_sequence: "1", operation_type: "Manufacturing", operation_name: "Mixing", cycle_time: 2700, work_centre_code: "MIXING" },
  { operation_sequence: "2", operation_type: "Manufacturing", operation_name: "Blending", cycle_time: 1200, work_centre_code: "BLENDING" },
];
const items = [
  { operation_sequence: "1", item_type: "Component" as const, item_code: "RAW0001", quantity: 200 },
  { operation_sequence: "1", item_type: "Resource" as const, item_code: "LAB1", quantity: 1 },
  { operation_sequence: "2", item_type: "Resource" as const, item_code: "MACH002", quantity: 1 },
];

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("toCin7ProductionBomPayload", () => {
  it("addresses the product by its Cin7 ID, not SKU", () => {
    const payload = toCin7ProductionBomPayload(cin7ProductId, version, operations, items);
    expect(payload.ProductID).toBe(cin7ProductId);
    expect(payload).not.toHaveProperty("SKU");
  });

  it("groups components and resources under the right operation", () => {
    const payload = toCin7ProductionBomPayload(cin7ProductId, version, operations, items);
    expect(payload.Operations).toHaveLength(2);
    const mixing = payload.Operations.find((o) => o.OperationSequence === "1")!;
    expect(mixing.Components).toEqual([{ ComponentSKU: "RAW0001", Quantity: 200 }]);
    expect(mixing.Resources).toEqual([{ ResourceCode: "LAB1", Quantity: 1 }]);
    const blending = payload.Operations.find((o) => o.OperationSequence === "2")!;
    expect(blending.Components).toEqual([]);
    expect(blending.Resources).toEqual([{ ResourceCode: "MACH002", Quantity: 1 }]);
  });
});

describe("pushProductionBom", () => {
  it("hits the confirmed /production/productionBOM path", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ProductionBOMs: [] }).mockResolvedValueOnce({ ID: "new" });

    await pushProductionBom(creds, cin7ProductId, version, operations, items);

    expect(cin7Request).toHaveBeenNthCalledWith(1, creds, "/production/productionBOM", expect.anything());
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/production/productionBOM", expect.objectContaining({ method: "POST" }));
  });

  it("creates via POST when the version doesn't exist yet", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ProductionBOMs: [] }).mockResolvedValueOnce({ ID: "new" });

    const result = await pushProductionBom(creds, cin7ProductId, version, operations, items);

    expect(result).toEqual({ status: "created" });
  });

  it("updates via PUT when a matching version already exists", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ ProductionBOMs: [{ Version: "1" }] })
      .mockResolvedValueOnce({ ID: "existing" });

    const result = await pushProductionBom(creds, cin7ProductId, version, operations, items);

    expect(result).toEqual({ status: "updated" });
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/production/productionBOM", expect.objectContaining({ method: "PUT" }));
  });
});
