import { describe, expect, it } from "vitest";
import { inspectProductionBom } from "@/rwtsa-live/bom";
import type { ReadOnlyClient } from "@/rwtsa-live/client";

const fake = (responses: Record<string, unknown>) => {
  const calls: string[] = [];
  const c: ReadOnlyClient = { get: async (path) => { calls.push(path); return responses[path] as never; }, requests: () => calls.length, methodsUsed: () => ["GET"] };
  return { c, calls };
};
const prod = { Products: [{ SKU: "X", ID: "11111111-1111-1111-1111-111111111111" }] };

describe("inspectProductionBom", () => {
  it("makes exactly two GETs and counts operations and components", async () => {
    const { c, calls } = fake({ "/product": prod, "/production/productionBOM": { ProductionBOMs: [{ Version: "1", IsDefault: true, Operations: [{ Components: [{}, {}] }, { Components: [{}] }] }] } });
    const e = await inspectProductionBom(c, "X");
    expect(calls).toEqual(["/product", "/production/productionBOM"]);
    expect(e).toMatchObject({ status: "BOM_PRESENT", requests: 2, versions: [{ version: "1", operations: 2, components: 3, isDefault: true }] });
  });
  it("recognises the LIVE response key ProductionBoms (verified 2026-11-14) as well as ProductionBOMs", async () => {
    for (const key of ["ProductionBoms", "ProductionBOMs"]) {
      const { c } = fake({ "/product": prod, "/production/productionBOM": { ProductID: "x", [key]: [{ Version: "1", Operations: [{ Components: [{}] }] }] } });
      expect((await inspectProductionBom(c, "X"))).toMatchObject({ status: "BOM_PRESENT", versions: [{ operations: 1, components: 1 }] });
    }
  });
  it("no versions is NO_BOM_FOUND (never created or assumed)", async () => {
    const { c } = fake({ "/product": prod, "/production/productionBOM": { ProductionBOMs: [] } });
    expect((await inspectProductionBom(c, "X")).status).toBe("NO_BOM_FOUND");
  });
  it("records the response top-level key names so an unrecognised shape is distinguishable from no BOM", async () => {
    const { c } = fake({ "/product": prod, "/production/productionBOM": { Other: [] } });
    const e = await inspectProductionBom(c, "X");
    expect(e.status).toBe("UNVERIFIED");
    expect(e.unverifiedReason).toMatch(/ProductionBoms/);
    expect(e.responseTopLevelFields).toEqual(["Other"]);
  });
  it.each([{}, { ProductionBOMs: null }, { ProductionBOMs: "x" }, { ProductionBOMs: {} }])("unrecognised BOM shape %j is UNVERIFIED, never NO_BOM_FOUND", async (body) => {
    const { c } = fake({ "/product": prod, "/production/productionBOM": body });
    expect((await inspectProductionBom(c, "X")).status).toBe("UNVERIFIED");
  });
  it("a BOM row for a different product is UNVERIFIED, not BOM_PRESENT", async () => {
    const { c } = fake({ "/product": prod, "/production/productionBOM": { ProductionBOMs: [{ Version: "1", ProductID: "99999999-9999-9999-9999-999999999999" }] } });
    expect((await inspectProductionBom(c, "X")).status).toBe("UNVERIFIED");
  });
  it("unknown product stops after one request", async () => {
    const { c, calls } = fake({ "/product": { Products: [{ SKU: "OTHER", ID: "a" }] } });
    expect((await inspectProductionBom(c, "X")).status).toBe("PRODUCT_NOT_FOUND");
    expect(calls).toEqual(["/product"]);
  });
  it("counts are null, not zero, when the response carries no operations", async () => {
    const { c } = fake({ "/product": prod, "/production/productionBOM": { ProductionBOMs: [{ Version: "1" }] } });
    expect((await inspectProductionBom(c, "X")).versions[0]).toMatchObject({ operations: null, components: null });
  });
  it("two products for one SKU refuse to continue", async () => {
    const { c, calls } = fake({ "/product": { Products: [{ SKU: "X", ID: "a" }, { SKU: "X", ID: "b" }] } });
    await expect(inspectProductionBom(c, "X")).rejects.toThrow();
    expect(calls).toEqual(["/product"]);
  });
});
