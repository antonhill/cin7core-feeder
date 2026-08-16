import { describe, expect, it } from "vitest";
import { matchesSearch } from "../text-search";

describe("matchesSearch", () => {
  it("matches case-insensitively against any given field", () => {
    expect(matchesSearch("wid-1", "SKU-WID-1", "Widget")).toBe(true);
    expect(matchesSearch("widget", "SKU-WID-1", "Widget")).toBe(true);
    expect(matchesSearch("gadget", "SKU-WID-1", "Widget")).toBe(false);
  });

  it("treats an empty or whitespace-only query as matching everything", () => {
    expect(matchesSearch("", "SKU-WID-1", null)).toBe(true);
    expect(matchesSearch("   ", null, undefined)).toBe(true);
  });

  it("treats null/undefined fields as empty rather than throwing", () => {
    expect(matchesSearch("x", null, undefined)).toBe(false);
  });
});
