import { describe, expect, it } from "vitest";
import { COST_SHEET_COLUMNS as C, ingestCostSheet } from "../cost-sheet";

const TODAY = "2026-12-01";
const ok = (over: Record<string, unknown> = {}) => ({ [C.sku]: "NQ3330", [C.cost]: 274.37, [C.currency]: "ZAR", [C.priceDate]: "2026-09-15", [C.basis]: "Sage latest cost", [C.approvedBy]: "Shirnel Davids", [C.approvalDate]: "2026-11-30", ...over });

describe("NewQuip cost-sheet return: validation only (no import, no Cin7 write)", () => {
  it("accepts a complete row with explicit provenance and records that nothing was applied", () => {
    const r = ingestCostSheet([ok()], TODAY);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual([{ sku: "NQ3330", unitCost: 274.37, currency: "ZAR", priceDate: "2026-09-15", basis: "Sage latest cost", approvedBy: "Shirnel Davids", approvalDate: "2026-11-30", freightTreatment: "landed_zar_no_extra_freight", provenance: "newquip_cost_sheet", applied: false }]);
  });
  it("a ZAR landed cost gets no second freight; a EUR/USD supplier-native price keeps the engine's freight", () => {
    const r = ingestCostSheet([ok({ [C.sku]: "A1", [C.currency]: "zar" }), ok({ [C.sku]: "A2", [C.currency]: "EUR", [C.cost]: 12.5 })], TODAY).accepted;
    expect(r.map((x) => x.freightTreatment)).toEqual(["landed_zar_no_extra_freight", "supplier_native_engine_freight"]);
  });
  it("an unanswered row is 'not answered', never accepted and never defaulted", () => {
    const r = ingestCostSheet([ok({ [C.cost]: "" }), ok({ [C.sku]: "X", [C.cost]: undefined })], TODAY);
    expect(r.accepted).toEqual([]); expect(r.rejected.map((x) => x.reason)).toEqual(["Not answered: no approved cost entered.", "Not answered: no approved cost entered."]);
  });
  it("rejects every doubtful field with the exact reason and never repairs it", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ [C.sku]: "N3771 -> NQ3771 [QUERY 1]" }, /not a plain product code/],
      [{ [C.cost]: 0 }, /greater than zero/], [{ [C.cost]: -5 }, /greater than zero/], [{ [C.cost]: "abc" }, /greater than zero/],
      [{ [C.cost]: 1.123456789 }, /more than 7 decimals/],
      [{ [C.currency]: "GBP" }, /ZAR, EUR or USD/], [{ [C.currency]: "" }, /ZAR, EUR or USD/],
      [{ [C.priceDate]: "" }, /price date/], [{ [C.priceDate]: "2026-02-30" }, /price date/], [{ [C.priceDate]: "2027-01-01" }, /future/],
      [{ [C.basis]: "" }, /basis/], [{ [C.approvedBy]: "" }, /approver/], [{ [C.approvedBy]: "12" }, /approver/],
      [{ [C.approvalDate]: "" }, /approval date/], [{ [C.approvalDate]: "2027-01-01" }, /future/], [{ [C.approvalDate]: "2026-09-01" }, /earlier than the price date/],
    ];
    for (const [over, re] of cases) { const r = ingestCostSheet([ok(over)], TODAY); expect(r.accepted, JSON.stringify(over)).toEqual([]); expect(r.rejected[0].reason, JSON.stringify(over)).toMatch(re); }
  });
  it("a duplicate SKU is rejected (the first answer stands) and Excel dates / decimal commas are read exactly", () => {
    const r = ingestCostSheet([ok(), ok({ [C.cost]: 999 }), ok({ [C.sku]: "Z9", [C.cost]: "1 234,5", [C.priceDate]: new Date("2026-09-15T00:00:00Z") })], TODAY);
    expect(r.accepted.map((x) => [x.sku, x.unitCost, x.priceDate])).toEqual([["NQ3330", 274.37, "2026-09-15"], ["Z9", 1234.5, "2026-09-15"]]);
    expect(r.rejected).toEqual([{ row: 2, sku: "NQ3330", reason: "Duplicate SKU in the sheet." }]);
  });
  it("is pure: it imports nothing that can write (no Cin7, no database, no quote store)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../cost-sheet.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import /m);
  });
});
