import { describe, expect, it } from "vitest";
import { COMMERCIAL_MAPPINGS, EXCLUDED_SKUS, SELECTABLE_ALTERNATIVES, SUPPLIED_COSTS, alternativesFor, isExcludedSku, manualSelectionSkusFor, packageAutoConfirmable, packageFor, referencedSkus, type PackageMapping } from "../commercial";
import { mappingError } from "../mapping-integrity";
import { mergeCandidates, resolveMapping } from "../mapping";
import { PENNING_COMPONENTS, penningScope } from "../penning";
import { compareSuppliedCost } from "../supplied-cost-compare";

// Sean / Tereesha's answers of 2026-11 applied to the Grower House template. Every correction is a confirmed IDENTITY; nothing here confirms a quantity, a cost basis or a selling price.
const pkg = (k: "led_light" | "flex_auger" | "cup_drinker") => packageFor(k) as PackageMapping;
const skusOf = (p: PackageMapping) => p.components.flatMap((c) => (c.sku ? [c.sku] : []));

describe("LED lighting: the three SKUs Sean confirmed", () => {
  const led = pkg("led_light");
  it("maps the luminaire, the clip and the cable to HNQ7046, HNQ7093 and HNQ7088, in their own quantities (not equal)", () => {
    const by = Object.fromEntries(led.components.map((c) => [c.id, c]));
    expect(by.luminaire).toMatchObject({ sku: "HNQ7046", identity: "source_backed", qtyPerUnit: 1 });
    expect(by.clip).toMatchObject({ sku: "HNQ7093", identity: "source_backed", qtyPerUnit: 3 });
    expect(by.cable).toMatchObject({ sku: "HNQ7088", identity: "source_backed", qtyPerUnit: 1 });
    expect(new Set(led.components.map((c) => c.qtyPerUnit)).size).toBe(2);
  });
  it("no longer offers the revolving-light / light-trap SKUs or any uncertain contender", () => {
    const ids = led.components.flatMap((c) => [c.sku, ...(c.candidateSkus ?? []), c.historicSurrogate?.sku]);
    for (const gone of ["HO12011000", "HO17050750", "HO21013750"]) { expect(ids).not.toContain(gone); expect(referencedSkus()).not.toContain(gone); }
    expect(led.components.every((c) => c.identity === "source_backed" && !c.candidateSkus)).toBe(true);
  });
  it("still needs an Estimator: Sean confirmed SKUs, not per-light quantities or the customer-facing FORTIS name", () => {
    expect(led.estimatorConfirmation).toMatch(/not their quantities/);
    expect(packageAutoConfirmable(led)).toBe(false);
  });
});

describe("M75 / drop-kit package", () => {
  const m75 = pkg("flex_auger");
  const c = (id: string) => m75.components.find((x) => x.id === id)!;
  it("keeps the distinction between component cost, package cost and selling price: the system stays Estimator-priced and nothing is auto-confirmed", () => {
    expect(m75.estimatorPriced).toBe(true);
    expect(packageAutoConfirmable(m75)).toBe(false);
  });
  it("NQ1942 is the complete drop kit with the supplied R30 as a component reference only; NQ1984 is never present", () => {
    expect(c("dropkit")).toMatchObject({ sku: "NQ1942", suppliedReference: { amountZar: 30, per: "each" } });
    expect(c("dropkit").suppliedReference!.basis).toMatch(/not the drop-kit package cost, not the M75 system price/);
    expect(JSON.stringify(m75)).not.toMatch(/"sku":"NQ1984"/);
  });
  it("the drop tube is NOT chosen: NQ.TUBE.63 (Sean) and NQ.TUBE.75 (Master) stay candidates; R52.72 is a reference", () => {
    expect(c("droptube")).toMatchObject({ sku: null, identity: "uncertain", candidateSkus: ["NQ.TUBE.63", "NQ.TUBE.75"], suppliedReference: { amountZar: 52.72 } });
  });
  it("NQ3132 is neither confirmed nor excluded: it stays a supplier-quote exception with its function and Cin7 name discrepancy recorded", () => {
    expect(c("drive")).toMatchObject({ sku: "NQ3132" });
    expect(c("drive").pricingException).toMatch(/SUPPLIER QUOTE REQUIRED/);
    expect(c("drive").note).toMatch(/DRIVE UNIT/);
    expect(isExcludedSku("NQ3132")).toBe(false);
  });
  it("the support post is KNQ050-900 (Sean's correction); NQ2601 appears nowhere in the template", () => {
    expect(c("post")).toMatchObject({ sku: "KNQ050-900", identity: "source_backed" });
    expect(referencedSkus()).not.toContain("NQ2601");
    expect(c("post").candidateSkus).toBeUndefined();
  });
  it("auger: the quantity unit is the METRE, with R57.37/m as an unreconciled reference (never multiplied by systems)", () => {
    expect(c("auger")).toMatchObject({ sku: "NQ1163", quantityUnit: "metre", quantityStatus: "requires_validation", qtyPerUnit: null, suppliedReference: { amountZar: 57.37, per: "metre" } });
    expect(c("auger").suppliedReference!.basis).toMatch(/NOT been reconciled/);
  });
  it("no SKU is listed twice in a package (no double counting)", () => {
    for (const p of [pkg("led_light"), m75, pkg("cup_drinker")]) { const s = skusOf(p); expect(new Set(s).size).toBe(s.length); }
  });
});

describe("PVC door", () => {
  it("proposes NQ3444 first, retires NQ2112 / NQ2113 / NQ2114, and records R9,000 as a reference whose basis is unestablished", () => {
    const d = COMMERCIAL_MAPPINGS.pvc_door!;
    expect(d.kind).toBe("unresolved");
    if (d.kind !== "unresolved") return;
    expect(d.proposedSku).toBe("NQ3444");
    expect(manualSelectionSkusFor("pvc_door")[0]).toBe("NQ3444");
    for (const r of ["NQ2112", "NQ2113", "NQ2114"]) { expect(d.retiredSkus).toContain(r); expect(manualSelectionSkusFor("pvc_door")).not.toContain(r); }
    expect(d.suppliedReference).toMatchObject({ amountZar: 9000, per: "each" });
    expect(d.suppliedReference!.basis).toMatch(/NOT a selling price, no markup is applied/);
    expect(d.reason).toMatch(/no component is added alongside it/);
  });
  it("is never selected automatically (a manual choice, not a catalogue default)", () => {
    expect(manualSelectionSkusFor("pvc_door").length).toBeGreaterThan(1);
  });
});

describe("inclusion and exclusion", () => {
  it("NQ1984 is excluded: never offered, refused when stored, and a confirmed NQ1984 resolves to UNMAPPED with the reason", () => {
    expect(EXCLUDED_SKUS.NQ1984).toMatch(/Excluded/);
    expect(referencedSkus()).not.toContain("NQ1984");
    expect(mappingError([{ itemKey: "flex_auger", sku: "NQ1984" }], [{ sku: "NQ1984", active: true }])).toMatch(/cannot be used: Excluded/);
    const cand = [{ sku: "NQ1984", name: "x" }, { sku: "NQ1942", name: "y" }];
    expect(mergeCandidates({ sku: "NQ1984", name: "x" }, cand).map((c) => c.sku)).toEqual(["NQ1942"]);
    expect(resolveMapping("pvc_door", cand, "NQ1984")).toMatchObject({ status: "UNMAPPED", sku: null, note: EXCLUDED_SKUS.NQ1984 });
  });
  it("PNQ002 and SYSH-2750-4 are choices within the feeder and bulk-tank lines only, never automatic, never extra lines", () => {
    expect(alternativesFor("feeder").map((a) => a.sku)).toEqual(["PNQ002"]);
    expect(alternativesFor("bulk_tank").map((a) => a.sku)).toEqual(["SYSH-2750-4"]);
    expect(SELECTABLE_ALTERNATIVES.every((a) => /never automatic|decision/.test(a.caution))).toBe(true);
    expect(mappingError([{ itemKey: "feeder", sku: "PNQ002" }], [{ sku: "PNQ002", active: true }])).toBeNull();
    expect(mappingError([{ itemKey: "bulk_tank", sku: "SYSH-2750-4" }], [{ sku: "SYSH-2750-4", active: true }])).toBeNull();
    // an alternative is valid only for ITS item, and a random product is still refused
    expect(mappingError([{ itemKey: "bulk_tank", sku: "PNQ002" }], [{ sku: "PNQ002", active: true }])).toMatch(/not the source-backed product/);
    expect(mappingError([{ itemKey: "feeder", sku: "NQ9999" }], [{ sku: "NQ9999", active: true }])).toMatch(/not the source-backed product/);
  });
  it("the tank alternative's caution records that Cin7's name says DONT QUOTE", () => {
    expect(alternativesFor("bulk_tank")[0].caution).toMatch(/DONT QUOTE/);
  });
});

describe("figures Sean / Tereesha supplied are references, compared with Cin7 and never applied", () => {
  it("lists exactly the seven supplied figures", () => {
    expect(SUPPLIED_COSTS.map((c) => [c.sku, c.amountZar, c.per])).toEqual([
      ["NQ1942", 30, "each"], ["NQ.TUBE.63", 52.72, "each"], ["NQ3444", 9000, "each"], ["NQ1163", 57.37, "metre"], ["NQ1764", 119.79, "each"], ["NQ1017", 3.14, "each"], ["NYNUT", 0.82, "each"],
    ]);
  });
  it("agrees / differs / no Cin7 cost / not found / foreign currency / per-metre unit basis are reported as such", () => {
    expect(compareSuppliedCost("NQ1017", { found: true, cost: 3.14, currency: "ZAR", lastSupplied: "2026-11-13" })).toMatchObject({ status: "agrees" });
    expect(compareSuppliedCost("NQ1764", { found: true, cost: 100, currency: "ZAR", lastSupplied: null })).toMatchObject({ status: "differs", differencePct: 19.79 });
    expect(compareSuppliedCost("NQ1942", { found: true, cost: null, currency: null, lastSupplied: null })).toMatchObject({ status: "cin7_has_no_cost" });
    expect(compareSuppliedCost("NQ.TUBE.63", undefined)).toMatchObject({ status: "not_in_cin7" });
    expect(compareSuppliedCost("NQ3444", { found: true, cost: 400, currency: "USD", lastSupplied: null })).toMatchObject({ status: "foreign_currency_not_comparable" });
    expect(compareSuppliedCost("NQ1163", { found: true, cost: 323.29, currency: "ZAR", lastSupplied: null })).toMatchObject({ status: "unit_basis_not_reconciled" });
  });
  it("every supplied SKU is in the survey universe so it can be checked live", () => {
    for (const c of SUPPLIED_COSTS) expect(referencedSkus()).toContain(c.sku);
  });
});

describe("penning as a component system", () => {
  const base = { lengthM: 49.5, widthM: 14.43, rooms: 12, penningPigSize: "MEDIUM" as const, penningRunningMetresPerRoom: 244.87 };
  it("carries exactly Sean's fifteen components, all for the 50 mm panel, none of them a polypropylene panel SKU", () => {
    expect(PENNING_COMPONENTS.map((c) => c.sku)).toEqual(["KNQ085", "KNQ085-880MM", "KNQ085-980MM", "KNQ074-A", "KNQ042-900", "KNQ043-900", "KNQ044-900", "KNQ045-900", "KNQ048-900", "KNQ049-900", "KNQ050-900", "KNQ051-900", "KNQ052-900", "KNQ079-900", "KNQ130-900"]);
    expect(PENNING_COMPONENTS.some((c) => /^KNQPP/.test(c.sku))).toBe(false);
  });
  it("derives only what the inputs give: running metres per room and for all rooms; the perimeter is context, not a quantity", () => {
    const s = penningScope(base);
    expect(s.runningMetresPerRoom).toBe(244.87);
    expect(s.projectRunningMetres).toBe(2938.44);
    expect(s.roomPerimeterReferenceM).toBe(127.86);
  });
  it("invents no component quantity: every component is an Estimator decision, and the decisions say so", () => {
    const s = penningScope(base);
    expect(s.components.every((c) => c.quantity === null && c.quantityStatus === "estimator_decision")).toBe(true);
    expect(s.decisions.join(" ")).toMatch(/Post spacing is not supplied/);
    expect(s.decisions.join(" ")).toMatch(/Cutting and wastage rules are not supplied/);
  });
  it("the panel is a SPECIFICATION (no SKU at quotation), and missing inputs are named as decisions", () => {
    const s = penningScope({ ...base, penningPigSize: null, penningRunningMetresPerRoom: null });
    expect(s.panel.skuStatus).toMatch(/created when the order is placed/);
    expect(s.panel.requiredFromEstimator).toEqual(["colour", "height (mm)", "cut length of each run (mm)", "number of panels"]);
    expect(s.projectRunningMetres).toBeNull();
    expect(s.decisions[0]).toMatch(/Select the pig size/);
    expect(s.decisions[1]).toMatch(/Enter the penning running metres/);
  });
  it("the support post is the same KNQ050-900 the M75 package uses", () => {
    expect(PENNING_COMPONENTS.find((c) => c.role === "support_post")!.sku).toBe(pkg("flex_auger").components.find((c) => c.id === "post")!.sku);
  });
});

describe("the item register never shows a supplied cost to a viewer without cost visibility", async () => {
  const { pocItemRegisterFor } = await import("../open-items");
  it("no amount, supplier figure or cost-basis wording reaches a Rep; a cost-entitled viewer reads the full text", () => {
    const repItems = pocItemRegisterFor(false).filter((i) => i.n >= 13);
    const rep = JSON.stringify(repItems);
    expect(repItems.length).toBeGreaterThan(0);
    expect(rep).not.toMatch(/\bR\s?\d|supplied reference|markup|basis not stated|Cin7 holds its own cost|NQ\.TUBE|R57|R30/);
    expect(rep).not.toMatch(/repTreatment/);
    const est = pocItemRegisterFor(true).find((i) => i.n === 14)!;
    expect(est.treatment).toMatch(/R9,000/);
  });
});

describe("saved reusable mappings that Sean's answers contradict are flagged, never rewritten", async () => {
  const { savedMappingCaution } = await import("../commercial");
  it("flags the revolving-light / light-trap LED mapping and the old penning set; says nothing about a mapping with only confirmed SKUs or about other packages", () => {
    expect(savedMappingCaution("led_light", ["HO12011000", "HO17050750", "HO21013750"])).toMatch(/HO12011000, HO17050750, HO21013750.*HNQ7046, HNQ7093 and HNQ7088/);
    expect(savedMappingCaution("penning_package", ["DPL-PVC20X600", "KNQ074"])).toMatch(/not on Sean's 2026-11 Grower Penning Posts list/);
    expect(savedMappingCaution("led_light", ["HNQ7046", "HNQ7093", "HNQ7088"])).toBeNull();
    expect(savedMappingCaution("flex_auger", ["NQ2064"])).toBeNull();
  });
});
