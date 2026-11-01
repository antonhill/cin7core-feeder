import { describe, expect, it } from "vitest";
import { parseCrmSettings } from "@/rwtsa-demo/state/crm-settings";

describe("Scenario D settings are parsed strictly; invalid values are reported and defaulted, never echoed", () => {
  it("defaults", () => {
    const s = parseCrmSettings({});
    expect(s).toMatchObject({ from: null, to: null, rep: null, customer: null, product: null, status: "ALL", grain: "month", compare: "count", errors: [] });
  });
  it("accepts valid values", () => {
    const s = parseCrmSettings({ from: "2026-02-01", to: "2026-02-28", rep: "Rep One", customer: "C1", product: "P1", status: "won", grain: "quarter", compare: "value" });
    expect(s).toMatchObject({ from: "2026-02-01", to: "2026-02-28", rep: "Rep One", customer: "C1", product: "P1", status: "WON", grain: "quarter", compare: "value", errors: [] });
  });
  it("rejects impossible calendar dates and non-ISO text, with a message that does not repeat the input", () => {
    for (const bad of ["2026-13-01", "2026-02-30", "01/02/2026", "tomorrow", "2026-2-1", "<script>alert(1)</script>"]) {
      const s = parseCrmSettings({ from: bad });
      expect(s.from, bad).toBeNull();
      expect(s.errors.join(" "), bad).not.toContain(bad);
      expect(s.errors.length, bad).toBe(1);
    }
    expect(parseCrmSettings({ from: "2024-02-29" }).from).toBe("2024-02-29"); // leap day
    expect(parseCrmSettings({ from: "2026-02-29" }).from).toBeNull();
  });
  it("a start after the end ignores both and says so", () => {
    const s = parseCrmSettings({ from: "2026-03-01", to: "2026-02-01" });
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
    expect(s.errors.join(" ")).toMatch(/start is after/i);
  });
  it("rejects unsupported status, grain and compare", () => {
    const s = parseCrmSettings({ status: "maybe", grain: "week", compare: "both" });
    expect(s).toMatchObject({ status: "ALL", grain: "month", compare: "count" });
    expect(s.errors).toHaveLength(3);
  });
  it("takes the first of a repeated parameter, ignores blanks, and bounds free text", () => {
    expect(parseCrmSettings({ rep: ["A", "B"] }).rep).toBe("A");
    expect(parseCrmSettings({ rep: "" }).rep).toBeNull();
    const s = parseCrmSettings({ customer: "x".repeat(121) });
    expect(s.customer).toBeNull();
    expect(s.errors).toHaveLength(1);
  });
  it("echoes only validated values", () => {
    const s = parseCrmSettings({ grain: "week", status: "lost" });
    expect(s.values).toMatchObject({ grain: "month", status: "LOST", compare: "count", from: "", to: "" });
  });
});
