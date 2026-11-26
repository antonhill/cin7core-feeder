// CUSTOMER UAT FEEDBACK (NQ-Q-0003 and commissioning). The NQ-Q-0003 draft below is the REAL saved draft (read from the database, nothing invented): five selected equipment lines with no Estimator-confirmed
// product, plus Delivery R8,000 and Installation R32,500. These tests pin the diagnosis (why each line is unpriced), the INCOMPLETE ESTIMATE wording, and the commissioning charge.
import { describe, expect, it } from "vitest";
import { emptyDraft, type QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { incompleteEstimateOf, incompleteEstimateText } from "../incomplete-estimate";
import { buildCustomerSummary, buildCustomerSummaryFromCommercial } from "../customer-summary";
import { testPriceSource } from "./test-snapshot";
import { readyDraft } from "./golden";
import { buildMarginSheet } from "@/newquip/quote/margin";

const ctx = { priceSource: testPriceSource(), withholdCost: true };
const costCtx = { priceSource: testPriceSource(), withholdCost: false };

function nqQ0003(): QuoteDraft {
  const d = emptyDraft();
  return {
    ...d, customerName: "NEWQUIP IMISHINI YOKULIMA (PTY) LTD", siteName: "TEST - Grower Ventilation", quoteType: "project",
    config: {
      ...d.config, rooms: 3, widthM: 11, lengthM: 72, totalPens: 32, hospitalPens: 0, pigsPerRoom: 700, feederVariant: "STANDARD", penningPigSize: "MEDIUM", selectedFeederType: "CCM", selectedDrinkerType: "CUP_NEW",
      selectedPenningType: "PP_GREEN_VENTED", selectedFlooringType: "CONCRETE_1200X450X70", selectedLightingType: "FORTIS_1_2_5000K", slattedFloorAreaM2: 0, penningRunningMetresPerRoom: 0,
      optionalEquipment: { cone_fans: true, controller: true, manure_plug: false, pad_cooling: true, control_panel: true, silo_weighing: false, emergency_windows: false },
      estimatorQuantities: { feeder: 0, pvc_door: 4, bulk_tank: 0, cone_fans: 4, controller: 1, flex_auger: 0, cup_drinker: 0, pad_cooling: 1, concrete_slat: 0, control_panel: 1 },
      quantityOverrides: { led_light: 0 }, quantityOverrideReasons: { led_light: "not needed", feed_saver_mat: "not needed" },
      exclusions: { feeder: "not needed", bulk_tank: "not needed", led_light: "not needed", flex_auger: "not needed", cup_drinker: "not needed", concrete_slat: "not needed", feed_saver_mat: "not needed", penning_package: "not needed" },
    },
    estimator: { ...d.estimator, charges: { delivery: 8000, installation: 32500 }, templateRevision: "grower-2026-11" },
  };
}

describe("NQ-Q-0003 revision 1: line-by-line diagnosis", () => {
  const ev = evaluateDraft(nqQ0003(), ctx);
  const line = (k: string) => ev.budget!.lines.find((l) => l.itemKey === k)!;
  it("the five selected equipment lines are unpriced because no product has been confirmed for them: quantity 12 / 3 / 3 / 3 / 12", () => {
    const expected: Record<string, number> = { pvc_door: 12, controller: 3, control_panel: 3, pad_cooling: 3, cone_fans: 12 };
    for (const [k, qty] of Object.entries(expected)) {
      expect(line(k).quantity, k).toBe(qty);
      // The intended source is an Estimator-confirmed Cin7 product; none exists, so no price is looked up or invented. The control panel (controller selected) alone has a documented FIXED Budget price that
      // awaits the Estimator's confirmation: still unpriced here, but it says what it is waiting for.
      expect(line(k).status, k).toBe(k === "control_panel" ? "package_unconfirmed" : "unmapped");
      if (k === "control_panel") expect(line(k).budgetBasis?.kind).toBe("fixed_selling_price");
      expect(line(k).sku, k).toBeNull();
      expect(line(k).revenueExTax, k).toBeNull();
    }
  });
  it("no equipment value is in the total: it is exactly Delivery + Installation (R40,500), and the budget is not complete", () => {
    expect(ev.budget!.totals.subtotalExTax).toBe(40_500);
    expect(ev.budget!.state).toBe("awaiting_pricing");
    expect(ev.budget!.pricedLineCount).toBe(0);
  });
  it("the incomplete-estimate warning names all five lines, and the known charge subtotal is separate from the (unavailable) project total", () => {
    const inc = incompleteEstimateOf(ev.budget)!;
    expect(inc.count).toBe(5);
    expect(inc.text).toBe("INCOMPLETE ESTIMATE — 5 equipment lines have no confirmed selling price. The displayed amount excludes these items and is not a complete quotation total.");
    expect(inc.chargesSubtotalExVat).toBe(40_500);
    expect(inc.pricedEquipmentExVat).toBe(0);
    expect(inc.lines.map((l) => l.itemKey).sort()).toEqual(["cone_fans", "control_panel", "controller", "pad_cooling", "pvc_door"]);
    expect(inc.lines.every((l) => l.reason === "Product not yet confirmed")).toBe(true);
  });
  it("the warning is customer-safe: no SKU, cost, supplier, rate or margin", () => {
    const inc = incompleteEstimateOf(ev.budget)!;
    expect(JSON.stringify(inc)).not.toMatch(/sku|cost|supplier|margin|landed|freight/i);
  });
  it("the same draft evaluated for a cost-visible viewer is unpriced in exactly the same way (the Rep and the Estimator see one truth)", () => {
    const e2 = evaluateDraft(nqQ0003(), costCtx);
    expect(e2.budget!.totals.subtotalExTax).toBe(40_500);
    expect(incompleteEstimateOf(e2.budget)!.count).toBe(5);
  });
  it("singular wording for one line", () => expect(incompleteEstimateText(1)).toBe("INCOMPLETE ESTIMATE — 1 equipment line has no confirmed selling price. The displayed amount excludes this item and is not a complete quotation total."));
  it("a fully priced quotation has NO incomplete estimate", () => expect(incompleteEstimateOf(evaluateDraft(readyDraft(), costCtx).budget)).toBeNull());
  it("an Estimator-confirmed mapping prices a line from the price source (the pipeline works once a product is confirmed): nothing is excluded by the engine", () => {
    const d = nqQ0003(); d.estimator.confirmedMappings = { pvc_door: "NQ2114" };
    expect(evaluateDraft(d, ctx).budget!.lines.find((l) => l.itemKey === "pvc_door")!.status).toBe("priced");
  });
});

describe("commissioning charge", () => {
  const base = readyDraft();
  const sub = (charges: QuoteDraft["estimator"]["charges"]) => evaluateDraft({ ...base, estimator: { ...base.estimator, charges: { ...base.estimator.charges, ...charges } } }, costCtx);
  it("UNSET: no commissioning line, no blocker, no change to the total (every existing quotation is unaffected)", () => {
    const ev = sub({});
    expect(ev.budget!.charges.map((c) => c.key)).toEqual(["delivery", "installation", "concrete_slat_delivery"]);
    expect(ev.budget!.blockers.join(" ")).not.toMatch(/Commissioning/);
    const withNull = sub({ commissioning: null });
    expect(withNull.budget!.totals.subtotalExTax).toBe(ev.budget!.totals.subtotalExTax);
    expect(withNull.readiness.state).toBe(ev.readiness.state);
  });
  it("entered: a separate charge that adds exactly its amount to the subtotal, VAT and grand total", () => {
    const a = sub({}).budget!.totals, b = sub({ commissioning: 7_500 }).budget!.totals;
    expect(b.subtotalExTax - a.subtotalExTax).toBeCloseTo(7_500, 6);
    expect(b.taxTotal - a.taxTotal).toBeCloseTo(1_125, 6);
    expect(b.totalIncTax - a.totalIncTax).toBeCloseTo(8_625, 6);
    expect(sub({ commissioning: 7_500 }).budget!.charges.find((c) => c.key === "commissioning")).toMatchObject({ amountExTax: 7_500, status: "entered" });
  });
  it("an explicit R0 is entered, adds nothing and does not block", () => {
    const ev = sub({ commissioning: 0 });
    expect(ev.budget!.totals.subtotalExTax).toBe(sub({}).budget!.totals.subtotalExTax);
    expect(ev.readiness.state).toBe(sub({}).readiness.state);
  });
  it("a negative amount is not accepted as a charge", () => expect(sub({ commissioning: -1 }).budget!.charges.find((c) => c.key === "commissioning")).toBeUndefined());
  it("the CUSTOMER summary combines Installation + Commissioning into ONE line, counted once (R32,500 + R7,500 = R40,000)", () => {
    const d = { ...base, estimator: { ...base.estimator, charges: { ...base.estimator.charges, installation: 32_500, commissioning: 7_500 } } };
    const s = buildCustomerSummary(evaluateDraft(d, costCtx).budget!)!;
    const lines = s.sections.filter((x) => /install|commission/i.test(x.title));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ title: "Installation & Commissioning", amountExVat: 40_000 });
    expect(s.sections.some((x) => x.title === "Delivery")).toBe(true);
    expect(s.sections.reduce((a, x) => a + x.amountExVat, 0)).toBeCloseTo(s.subtotalExVat, 2); // sections add up to the sub-total: nothing doubled or dropped
  });
  it("with no commissioning the customer line keeps its ORIGINAL wording and amount (historic documents unchanged)", () => {
    const s = buildCustomerSummary(sub({}).budget!)!;
    expect(s.sections.find((x) => /install/i.test(x.title))).toMatchObject({ title: "Installation", amountExVat: 400_000 });
  });
  it("from a SEALED baseline: an older baseline (no commissioning key) is unchanged; one with commissioning is combined once", () => {
    const old = buildCustomerSummaryFromCommercial({ lines: [], charges: [{ key: "delivery", amountCents: 800_000 }, { key: "installation", amountCents: 3_250_000 }], subtotalCents: 4_050_000, taxCents: 607_500, totalCents: 4_657_500 });
    expect(old.sections.map((x) => [x.title, x.amountExVat])).toEqual([["Delivery", 8_000], ["Installation", 32_500]]);
    const neu = buildCustomerSummaryFromCommercial({ lines: [], charges: [{ key: "delivery", amountCents: 800_000 }, { key: "installation", amountCents: 3_250_000 }, { key: "commissioning", amountCents: 750_000 }], subtotalCents: 4_800_000, taxCents: 720_000, totalCents: 5_520_000 });
    expect(neu.sections.map((x) => [x.title, x.amountExVat])).toEqual([["Delivery", 8_000], ["Installation & Commissioning", 40_000]]);
    expect(neu.subtotalExVat).toBe(48_000);
  });
  it("internally the margin sheet keeps commissioning as its own uncosted charge in 'Delivery & installation' (individual breakdown retained, nothing in the margin)", () => {
    const d = { ...base, estimator: { ...base.estimator, charges: { ...base.estimator.charges, commissioning: 7_500 } } };
    const budget = evaluateDraft(d, costCtx).budget!;
    const sheet = buildMarginSheet(budget, {});
    expect(sheet.project.uncostedChargesCents).toBe(Math.round((250_000 + 400_000 + 36_000 + 7_500) * 100));
  });
});
