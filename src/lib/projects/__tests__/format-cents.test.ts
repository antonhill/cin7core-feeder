import { describe, expect, it } from "vitest";
import { formatCents } from "../project-view";
import { formatZarCents } from "../../format-money";

// formatCents is a thin wrapper over the shared SA formatter; its detailed spec lives in src/lib/__tests__/format-money.test.ts.
describe("formatCents", () => {
  it.each([
    [100000000, "R\u00A01\u00A0000\u00A0000,00"],
    [50000000, "R\u00A0500\u00A0000,00"],
    [95000000, "R\u00A0950\u00A0000,00"],
    [0, "R\u00A00,00"],
    [5, "R\u00A00,05"],
    [-150000, "-R\u00A01\u00A0500,00"],
  ])("%i cents renders as %s", (cents, visual) => {
    expect(formatCents(cents)).toBe(visual);
  });

  it("is exactly the shared formatter (one format everywhere)", () => {
    for (const c of [0, 1, 99, 100, 123456789, -5]) expect(formatCents(c)).toBe(formatZarCents(c));
  });
});
