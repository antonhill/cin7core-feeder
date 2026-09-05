import { describe, expect, it } from "vitest";
import { formatCount } from "@/lib/format-count";

describe("formatCount", () => {
  it("formats with a comma separator regardless of the host's default locale", () => {
    // The whole point: this assertion must hold on a CI runner (typically
    // en-US or the C locale) AND on a machine whose default is en-ZA, de-DE,
    // fr-FR — all of which render 10000 differently under a bare
    // toLocaleString(). Asserting the literal string is what makes the
    // guarantee real; a locale-derived expectation would assert nothing.
    expect(formatCount(10_000)).toBe("10,000");
    expect(formatCount(75_000)).toBe("75,000");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });

  it("does not disagree with the host locale by accident — it genuinely ignores it", () => {
    // If this ever fails while the test above passes, the helper has started
    // deferring to the ambient locale again.
    const ambient = (10_000).toLocaleString();
    expect(formatCount(10_000)).toBe("10,000");
    if (ambient !== "10,000") expect(formatCount(10_000)).not.toBe(ambient);
  });

  it("leaves small numbers and zero unseparated", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });
});
