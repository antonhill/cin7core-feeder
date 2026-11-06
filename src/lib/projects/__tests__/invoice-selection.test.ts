import { describe, expect, it } from "vitest";
import { clearSelection, populateEligible, selectAllEligible, selectionToQuantities, toggleLine, visibleLines } from "../invoice-selection";

type L = Parameters<typeof selectAllEligible>[0][number];
const lines: L[] = [
  { sku: "A", status: "PROPOSED", eligible: 5, maxSelectable: 8 },
  { sku: "B", status: "NOTHING_ELIGIBLE", eligible: 0, maxSelectable: 4 },
  { sku: "C", status: "UNKNOWN", eligible: null, maxSelectable: 0 },
  { sku: "D", status: "EXCLUDED", eligible: 0, maxSelectable: 3 },
  { sku: "E", status: "PROPOSED", eligible: 9, maxSelectable: 6 }, // eligible above what the Sale still allows
];

describe("UAT-024 bulk product selection", () => {
  it("select all eligible picks only lines with something eligible, capped at what the Sale still allows", () => {
    const s = selectAllEligible(lines);
    expect([...s.selected].sort()).toEqual(["A", "E"]);
    expect(s.qty).toMatchObject({ A: "5", B: "0", C: "0", D: "0", E: "6" });
  });
  it("clear selection empties everything", () => {
    const s = clearSelection(lines);
    expect(s.selected.size).toBe(0);
    expect(selectionToQuantities(lines, s)).toEqual([]);
  });
  it("populate eligible fills only the selected lines and leaves a typed early quantity alone when nothing is eligible", () => {
    const cur = { selected: new Set(["A", "B"]), qty: { A: "1", B: "2", E: "0" } };
    const s = populateEligible(lines, cur);
    expect(s.qty).toMatchObject({ A: "5", B: "2", E: "0" });
  });
  it("unknown and excluded lines can never be selected or sent", () => {
    for (const sku of ["C", "D"]) {
      const s = toggleLine(lines, clearSelection(lines), sku, true);
      expect(s.selected.has(sku)).toBe(false);
    }
    const forced = { selected: new Set(["C", "D"]), qty: { C: "3", D: "3" } };
    expect(selectionToQuantities(lines, forced)).toEqual([]);
  });
  it("toggling a line on proposes its eligible quantity; off zeroes it", () => {
    let s = toggleLine(lines, clearSelection(lines), "A", true);
    expect(s.qty.A).toBe("5");
    s = toggleLine(lines, s, "A", false);
    expect(s.qty.A).toBe("0");
    expect(s.selected.has("A")).toBe(false);
  });
  it("show selected only filters the view without changing the selection", () => {
    const s = selectAllEligible(lines);
    expect(visibleLines(lines, s, true).map((l) => l.sku)).toEqual(["A", "E"]);
    expect(visibleLines(lines, s, false)).toHaveLength(5);
  });
  it("only selected, positive, finite quantities are sent (an unselected line with a stale quantity is not)", () => {
    const sel = { selected: new Set(["A"]), qty: { A: "2", E: "4", B: "abc" } };
    expect(selectionToQuantities(lines, sel)).toEqual([{ sku: "A", quantity: 2 }]);
  });
});
