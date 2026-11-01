import { describe, expect, it } from "vitest";
import { formatRate } from "@/rwtsa-demo/state/crm-format";

describe("rate formatting never rounds to a false extreme", () => {
  it("N/A, edges and ordinary values", () => {
    expect(formatRate(null)).toBe("N/A");
    expect(formatRate(0)).toBe("0.0%");
    expect(formatRate(100)).toBe("100.0%");
    expect(formatRate(1 / 30)).toBe("<0.1%");
    expect(formatRate(0.05)).toBe("0.1%");
    expect(formatRate(99.97)).toBe(">99.9%");
    expect(formatRate(99.94)).toBe("99.9%");
    expect(formatRate(55.5556)).toBe("55.6%");
  });
});
