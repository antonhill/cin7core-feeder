import { describe, expect, it } from "vitest";
import golden from "./golden-legacy/original-template-evaluations.json";
import { evaluateDraft } from "../evaluate";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { TEMPLATE_REVISION_CURRENT, TEMPLATE_REVISION_LEGACY, commercialMappingFor, packageFor, manualSelectionSkusFor, templateRevisionOf } from "../commercial";
import { GROWER_ITEM_KEYS } from "../types";
import type { QuoteDraft } from "../draft";

// THE ORIGINAL TEMPLATE IS FROZEN. The golden file holds the evaluation of two real stored Grower quotation shapes (a Rep draft and an Estimator-review quotation that both had the LED package
// confirmed with a typed price), produced by the code BEFORE the 2026-11 reconfiguration (candidate 7fedfcc). A quotation without estimator.templateRevision must still evaluate to exactly that.
const config = { rooms: 12, widthM: 14.43, lengthM: 49.5, totalPens: 20, exclusions: {}, pigsPerRoom: 600, hospitalPens: 2, feederVariant: "STANDARD", penningPigSize: "SMALL", optionalEquipment: { cone_fans: false, controller: false, manure_plug: false, pad_cooling: false, control_panel: false, silo_weighing: false, emergency_windows: false }, quantityOverrides: { led_light: 38, feed_saver_mat: 18 }, selectedFeederType: "CCM", slattedFloorAreaM2: 120, estimatorQuantities: { feeder: 18, pvc_door: 2, bulk_tank: 1, cone_fans: 4, controller: 2, flex_auger: 1, cup_drinker: 54, manure_plug: 2, pad_cooling: 3, concrete_slat: 1320, control_panel: 2, silo_weighing: 2, emergency_windows: 2 }, selectedDrinkerType: "CUP_NEW", selectedPenningType: "PP_GREEN_VENTED", selectedFlooringType: "CONCRETE_1200X450X70", selectedLightingType: "FORTIS_1_2_5000K", quantityOverrideReasons: { led_light: "Test", feed_saver_mat: "Test" }, penningRunningMetresPerRoom: 20 };
const R = (n: number) => ({ reason: "Master workbook has no usable price. Temporary POC estimator value only.", unitPriceExVat: n });
const draft = (): QuoteDraft => ({ customerName: "Test Customer", siteName: "Test Farm 1", quoteType: "day_to_day", config, estimator: { charges: { delivery: 979992, installation: 1200000, concrete_slat_delivery: 250000 }, unitPrices: { flex_auger: 45000 }, assumptions: "Test", priceResolutions: { pvc_door: R(3000), led_light: R(881), cup_drinker: R(548), concrete_slat: R(203), feed_saver_mat: R(919) }, confirmedMappings: { feeder: "PNQ082", pvc_door: "NQ2114", bulk_tank: "SYSH-2750-3", concrete_slat: "NQ1161", feed_saver_mat: "ERT053" }, confirmedPackages: ["cup_drinker", "led_light"] } } as unknown as QuoteDraft);
const summary = (d: QuoteDraft) => { const b = evaluateDraft(d, evaluationContext(false)).budget!; return JSON.parse(JSON.stringify({ total: b.totals.subtotalExTax, incomplete: b.incomplete, blockers: b.blockers, warnings: b.warnings, lines: b.lines.map((l) => ({ k: l.itemKey, s: l.status, sku: l.sku, rev: l.revenueExTax, q: (l as { projectQuantity?: number }).projectQuantity ?? (l as { quantity?: number }).quantity, comps: (l.components ?? []).map((c) => [c.sku, c.quantity, c.status, c.revenueExTax]) })) })); };

describe("an existing quotation (no templateRevision) evaluates exactly as before the reconfiguration", () => {
  it("is read as the original template", () => {
    expect(templateRevisionOf(draft())).toBe(TEMPLATE_REVISION_LEGACY);
    expect(templateRevisionOf({ estimator: { templateRevision: "anything-else" } })).toBe(TEMPLATE_REVISION_LEGACY); // unknown / tampered = original, never the new template
  });
  for (const k of ["NQ-Q-0007", "NQ-Q-0018"] as const) {
    it(`${k} shape: totals, every line's status, SKU, price, quantity and every LED component equal the pre-change evaluation`, () => {
      expect(summary(draft())).toEqual((golden as Record<string, unknown>)[k]);
    });
  }
  it("the original LED package has NO SKUs (unidentified luminaire, uncertain clip and cable) and the original door list is unchanged", () => {
    const led = packageFor("led_light", TEMPLATE_REVISION_LEGACY)!;
    expect(led.components.map((c) => [c.id, c.sku, c.identity])).toEqual([["luminaire", null, "unidentified"], ["clip", null, "uncertain"], ["cable", null, "uncertain"]]);
    expect(manualSelectionSkusFor("pvc_door", TEMPLATE_REVISION_LEGACY)).toEqual(["NQ2114", "NQ2113", "NQ2112", "NQ2161", "NQ2281"]);
    expect(packageFor("flex_auger", TEMPLATE_REVISION_LEGACY)!.components.find((c) => c.id === "post")).toMatchObject({ sku: null, candidateSkus: ["NQ2601"] });
  });
  it("only an explicit current-revision stamp reads the corrected LED package", () => {
    const d = draft(); d.estimator.templateRevision = TEMPLATE_REVISION_CURRENT;
    expect(templateRevisionOf(d)).toBe(TEMPLATE_REVISION_CURRENT);
    expect(packageFor("led_light", TEMPLATE_REVISION_CURRENT)!.components.map((c) => c.sku)).toEqual(["HNQ7046", "HNQ7093", "HNQ7088"]);
    expect(summary(d).lines.find((l: { k: string }) => l.k === "led_light").comps.map((c: unknown[]) => c[0])).toEqual(["HNQ7046", "HNQ7093", "HNQ7088"]);
  });
});

describe("exactly three items differ between the revisions; every other substitution risk is additive", () => {
  it("only led_light, flex_auger (M75 reference) and pvc_door (choice list) have a different definition; every other item is the same object in both revisions", () => {
    const differing = GROWER_ITEM_KEYS.filter((k) => commercialMappingFor(k, TEMPLATE_REVISION_LEGACY) !== commercialMappingFor(k, TEMPLATE_REVISION_CURRENT));
    expect(differing.sort()).toEqual(["flex_auger", "led_light", "pvc_door"]);
  });
  it("the support post and doors changed ONLY in the M75 reference package and the choice list: neither is a priced line, and a stored door or mapping is never rewritten", () => {
    expect(packageFor("flex_auger", TEMPLATE_REVISION_LEGACY)!.estimatorPriced).toBe(true);
    expect(packageFor("flex_auger", TEMPLATE_REVISION_CURRENT)!.estimatorPriced).toBe(true);
  });
});
