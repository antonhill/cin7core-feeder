import { describe, expect, it, vi, beforeEach } from "vitest";
import { toCin7ProductionBomPayload, pushProductionBom } from "@/cin7/production-bom";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };
const cin7ProductId = "cin7-product-guid";
const version = { product_sku: "FACEBULK001", version: "1", version_name: null, quantity_to_produce: 1000 };
const operations = [
  { operation_sequence: "1", operation_type: "Manufacturing", operation_name: "Mixing", cycle_time: 2700, unit_per_cycle: 1000, work_centre_code: "MIXING" },
  { operation_sequence: "2", operation_type: "Manufacturing", operation_name: "Blending", cycle_time: 1200, unit_per_cycle: 1000, work_centre_code: "BLENDING" },
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
    expect(mixing.Components).toEqual([{ Position: 1, ComponentSKU: "RAW0001", Quantity: 200 }]);
    expect(mixing.Resources).toEqual([{ Position: 1, ResourceCode: "LAB1", Quantity: 1 }]);
    const blending = payload.Operations.find((o) => o.OperationSequence === "2")!;
    expect(blending.Components).toEqual([]);
    expect(blending.Resources).toEqual([{ Position: 1, ResourceCode: "MACH002", Quantity: 1 }]);
  });

  it("gives every Operation, Component, and Resource a 1-indexed Position (required by Cin7)", () => {
    const payload = toCin7ProductionBomPayload(cin7ProductId, version, operations, items);
    expect(payload.Operations.map((o) => o.Position)).toEqual([1, 2]);
    const mixing = payload.Operations.find((o) => o.OperationSequence === "1")!;
    expect(mixing.Components[0].Position).toBe(1);
    expect(mixing.Resources[0].Position).toBe(1);
  });

  it("includes Order and UnitsPerCycle on operations, and OutputQuantity at the top level (all required by Cin7)", () => {
    const payload = toCin7ProductionBomPayload(cin7ProductId, version, operations, items);
    expect(payload.OutputQuantity).toBe(1000);
    expect(payload.Operations.map((o) => o.Order)).toEqual([1, 2]);
    expect(payload.Operations[0].UnitsPerCycle).toBe(1000);
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

  it("wraps the body in a ProductionBOMs array (confirmed via a live 400: 'Required attribute ProductionBOMs is not provided')", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ProductionBOMs: [] }).mockResolvedValueOnce({ ID: "new" });

    await pushProductionBom(creds, cin7ProductId, version, operations, items);

    const [, , options] = vi.mocked(cin7Request).mock.calls[1];
    const body = options?.body as { ProductionBOMs: unknown[] };
    expect(Array.isArray(body.ProductionBOMs)).toBe(true);
    expect(body.ProductionBOMs).toHaveLength(1);
    expect(body.ProductionBOMs[0]).toMatchObject({ ProductID: cin7ProductId });
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
