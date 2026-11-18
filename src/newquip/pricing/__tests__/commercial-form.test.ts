import { describe, expect, it } from "vitest";
import { bpsToPct, centsToRand, decimalToMicro, microToDecimal, pctToBps, randToCents } from "../commercial-form";

describe("settings form: exact text <-> integer conversions", () => {
  it("percent <-> bps", () => { expect(pctToBps("20")).toBe(2000); expect(pctToBps("17.5")).toBe(1750); expect(pctToBps("0.05")).toBe(5); expect(bpsToPct(1750)).toBe("17.5"); expect(bpsToPct(2000)).toBe("20"); });
  it("factor and rate <-> micro", () => { expect(decimalToMicro("1.15")).toBe(1_150_000); expect(decimalToMicro("19.123456")).toBe(19_123_456); expect(microToDecimal(1_150_000)).toBe("1.15"); expect(microToDecimal(1_000_000)).toBe("1"); });
  it("rand <-> cents", () => { expect(randToCents("5")).toBe(500); expect(randToCents("12.34")).toBe(1234); expect(centsToRand(1234)).toBe("12.34"); expect(centsToRand(500)).toBe("5"); });
  it("refuses more precision than the field holds, negatives, junk and blanks (never rounds)", () => {
    for (const t of ["1.1234567", "-1", "abc", "", "1,5", "1e3", " "]) expect(decimalToMicro(t)).toBeNull();
    expect(pctToBps("1.234")).toBeNull(); expect(randToCents("1.234")).toBeNull();
  });
});
