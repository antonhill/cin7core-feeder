import { describe, expect, it } from "vitest";
import { usdEstimateFromRate } from "@/lib/fx";

describe("usdEstimateFromRate", () => {
  it("rounds the ZAR 799 base price to the nearest whole dollar at today's rate", () => {
    expect(usdEstimateFromRate(16.3201)).toBe(49);
  });

  it("tracks a weaker rand into a lower USD estimate", () => {
    expect(usdEstimateFromRate(20)).toBe(40);
  });

  it("tracks a stronger rand into a higher USD estimate", () => {
    expect(usdEstimateFromRate(10)).toBe(80);
  });
});
