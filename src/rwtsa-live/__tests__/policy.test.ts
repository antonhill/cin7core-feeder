import { describe, expect, it } from "vitest";
import { assertReadOnlyRequest, ALLOWED_GET_PATHS } from "@/rwtsa-live/policy";

describe("read-only request policy", () => {
  it("accepts GET on each allowlisted path and roots it at the one Cin7 origin", () => {
    for (const p of ALLOWED_GET_PATHS) expect(assertReadOnlyRequest("GET", p).origin).toBe("https://inventory.dearsystems.com");
  });
  it.each(["POST", "PUT", "DELETE", "PATCH", "get", "HEAD", ""])("refuses method %j", (m) => {
    expect(() => assertReadOnlyRequest(m, "/ref/productavailability")).toThrow(/read-only/i);
  });
  it.each(["/sale", "/purchase", "/stockTransfer", "/production/order", "/ref/productavailability/../sale", "https://evil.example/x", "ref/location", "/ref/locationx", "/product/123"])("refuses path %j", (p) => {
    expect(() => assertReadOnlyRequest("GET", p)).toThrow();
  });
});
