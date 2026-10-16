import { describe, expect, it } from "vitest";
import { formatCents } from "../project-view";

describe("formatCents", () => {
  it.each([
    [100000000, "R 1,000,000.00"],
    [50000000, "R 500,000.00"],
    [95000000, "R 950,000.00"],
    [0, "R 0.00"],
    [5, "R 0.05"],
    [-150000, "-R 1,500.00"],
  ])("%i cents renders as %s", (cents, visual) => {
    expect(formatCents(cents)).toBe(visual.replace("R ", "R "));
  });

  it("joins the symbol and amount with U+00A0, never an ASCII space, so the R cannot wrap away", () => {
    for (const c of [0, 99, 100000000, -100000000, 1000000000]) {
      const s = formatCents(c);
      const i = s.indexOf("R");
      expect(s.charCodeAt(i + 1)).toBe(0x00a0);
      expect(s).not.toMatch(/R /);
      expect(s).not.toContain(" ");
    }
  });
});
