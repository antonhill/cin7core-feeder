import { describe, expect, it } from "vitest";
import { estimateFromRate } from "@/lib/fx";

describe("estimateFromRate", () => {
  it("rounds the ZAR 799 base price to the nearest whole unit at today's USD rate", () => {
    expect(estimateFromRate(16.3201)).toBe(49);
  });

  it("rounds at today's EUR rate", () => {
    expect(estimateFromRate(18.758)).toBe(43);
  });

  it("rounds at today's GBP rate", () => {
    expect(estimateFromRate(21.9102)).toBe(36);
  });

  it("tracks a weaker rand into a lower estimate", () => {
    expect(estimateFromRate(20)).toBe(40);
  });

  it("tracks a stronger rand into a higher estimate", () => {
    expect(estimateFromRate(10)).toBe(80);
  });
});
