import { describe, expect, it } from "vitest";
import { readyDraft } from "../../grower/__tests__/golden";
import { hashOf } from "../../quote/baseline";
import { currentPricingRuleSet } from "../rule-set";
import { PROJECT_MARKUP_PCT } from "../../grower/workbook-price-source";
import { GROWER_RULESET_VERSION } from "../../grower/final-feedback";
import { evalOf } from "./helpers";

// NQ-008A promised that NO existing calculation moved. These figures were captured from the pristine baseline (UX-007 merge 87fee32) BEFORE this work and are
// pinned here: every line's quantity, unit price, revenue and cost, and every total, for both quotation types. The same probe was run on the baseline and on this
// branch and produced byte-identical output (sha256 23ee18a1ac708aa9...). A change to any of these is a change to NewQuip's pricing and needs the owner's approval.
const structure = (qt: "project" | "day_to_day") => {
  const b = evalOf(readyDraft({ quoteType: qt }), false).budget!;
  return {
    lines: b.lines.map((l) => [l.itemKey, l.status, l.quantity, l.unitPrice, l.revenueExTax, l.estimatedCost]),
    charges: b.charges.map((c) => [c.key, c.amountExTax]),
    sub: b.totals.subtotalExTax, tax: b.totals.taxTotal, inc: b.totals.totalIncTax, cost: b.totals.estimatedCost,
  };
};

describe("existing pricing is unchanged (cent-for-cent against the pre-NQ-008A baseline)", () => {
  it("PROJECT quotation: totals and every line", () => {
    const s = structure("project");
    expect([s.sub, s.tax, s.inc, s.cost]).toEqual([8609542.4, 1291431.3599999999, 9900973.76, 3341952]);
    expect(hashOf(s)).toBe("47a177dc563b2473b9905b7e7b5ccebf1ffdb7ba45b8196c87c029548522c025");
  });
  it("DAY-TO-DAY quotation: totals and every line", () => {
    const s = structure("day_to_day");
    expect([s.sub, s.tax, s.inc, s.cost]).toEqual([9277932.8, 1391689.9200000002, 10669622.72, 3341952]);
    expect(hashOf(s)).toBe("1551965d3d0d16ffca8c14de44d0b36bdf729366fc58970d76a4a4b6209f79bf");
  });
  it("the project markup is still the existing 20% on landed cost, and the rule-set descriptor only REPORTS existing constants", () => {
    expect(PROJECT_MARKUP_PCT).toBe(20);
    const rs = currentPricingRuleSet();
    expect(rs.projectMarkupPctOnLandedCost).toBe(20);
    expect(rs.version).toBe(GROWER_RULESET_VERSION);
    expect(Object.keys(rs).sort()).toEqual(["id", "projectMarkupPctOnLandedCost", "template", "version"]); // no margin limit, freight or installation rule has been added
  });
});
