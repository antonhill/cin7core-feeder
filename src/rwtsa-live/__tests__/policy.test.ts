import { describe, expect, it } from "vitest";
import { assertReadOnlyRequest, ALLOWED_GET_PATHS } from "@/rwtsa-live/policy";

describe("read-only request policy", () => {
  it("allows exactly the three read paths plus the three Phase 3 production reads, nothing else", () => {
    expect([...ALLOWED_GET_PATHS].sort()).toEqual(["/product", "/production/order", "/production/order/run", "/production/orderList", "/production/productionBOM", "/ref/location", "/ref/productavailability"]);
  });
  it("accepts GET on each allowlisted path and roots it at the one Cin7 origin", () => {
    for (const p of ALLOWED_GET_PATHS) expect(assertReadOnlyRequest("GET", p).origin).toBe("https://inventory.dearsystems.com");
  });
  it.each(["POST", "PUT", "DELETE", "PATCH", "get", "HEAD", ""])("refuses method %j", (m) => {
    expect(() => assertReadOnlyRequest(m, "/ref/productavailability")).toThrow(/read-only/i);
  });
  it.each(["/sale", "/purchase", "/stockTransfer", "/ref/productavailability/../sale", "https://evil.example/x", "ref/location", "/ref/locationx", "/product/123", "/production/order/runs", "/production/orders", "/production/productionBOM/", "/production/productionBom", "/production/orderList/x"])("refuses path %j", (p) => {
    expect(() => assertReadOnlyRequest("GET", p)).toThrow();
  });
});
