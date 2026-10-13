import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_MAPPINGS, MANUAL_COMMERCIAL_LINES, commercialMappingFor, manualLinesFor, packageFor, recommendedSkuFor, referencedSkus,
} from "../commercial";
import { calculateGrowerHouse } from "../calculate";
import { GROWER_RULES } from "../rules";
import { TOPIGS_GROWER_INPUT } from "../fixture";
import { mergeCandidates, resolveMapping, type MappingCandidate } from "../mapping";
import { buildBudgetQuote, costTrust, availabilityTrust, type ProductCommercials } from "../quote-bridge";
import type { GrowerItemKey } from "../types";

const prod = (sku: string, cost: number | null, price: number | null, available = 500): ProductCommercials => ({
  sku, name: sku, active: true, averageCost: cost, tierPrices: price == null ? {} : { Tier1: price }, available,
});
const opts = (confirmed: GrowerItemKey[] = []) => ({ tierCode: "Tier1", taxRatePct: 15, taxInclusive: false, confirmedPackages: new Set(confirmed) });
const withQty = (q: Partial<Record<GrowerItemKey, number>>) => calculateGrowerHouse({ ...TOPIGS_GROWER_INPUT, quantityOverrides: q });

describe("source-backed single-SKU recommendations", () => {
  it.each([
    ["bulk_tank", "SYSH-2750-3"],
    ["feeder", "PNQ082"],
    ["feed_saver_mat", "ERT053"],
    ["concrete_slat", "NQ1161"],
  ] as const)("%s recommends %s", (item, sku) => {
    expect(recommendedSkuFor(item)?.recommendedSku).toBe(sku);
    expect(commercialMappingFor(item)?.kind).toBe("single");
  });
  it("never recommends the DON'T QUOTE silo or the superseded feeder", () => {
    const all = referencedSkus();
    expect(all).not.toContain("SYSH-2750-4");
    expect(all).not.toContain("PNQ002");
  });
  it("a recommendation is NOT a human confirmation: status stays AMBIGUOUS and sku stays null until confirmed", () => {
    const cands = mergeCandidates({ sku: "PNQ082", name: "x" }, [{ sku: "PNQ002", name: "y" }]);
    const r = resolveMapping("feeder", cands, null);
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.sku).toBeNull();
    expect(r.awaitingConfirmationOfRecommendation).toBe(true);
    expect(resolveMapping("feeder", cands, "PNQ082")).toMatchObject({ status: "MAPPED", sku: "PNQ082", awaitingConfirmationOfRecommendation: false });
  });
  it("precedence: the source-backed SKU is listed first, fuzzy candidates follow, duplicates removed", () => {
    const fuzzy: MappingCandidate[] = [{ sku: "PNQ002", name: "a" }, { sku: "PNQ082", name: "dup" }, { sku: "PNQ082-WINDOW", name: "w" }];
    const merged = mergeCandidates({ sku: "PNQ082", name: "real" }, fuzzy);
    expect(merged.map((c) => c.sku)).toEqual(["PNQ082", "PNQ002", "PNQ082-WINDOW"]);
    expect(merged[0]).toMatchObject({ recommended: true, name: "real" });
  });
  it("no recommendation leaves fuzzy candidates unchanged (and unconfirmed)", () => {
    const fuzzy: MappingCandidate[] = [{ sku: "A", name: "a" }];
    expect(mergeCandidates(null, fuzzy)).toBe(fuzzy);
    expect(resolveMapping("pvc_door", fuzzy, null).status).toBe("AMBIGUOUS");
  });
});

describe("grower cup drinker package", () => {
  const pkg = packageFor("cup_drinker")!;
  it("resolves as a PACKAGE, not a single SKU", () => {
    expect(commercialMappingFor("cup_drinker")?.kind).toBe("package");
    expect(recommendedSkuFor("cup_drinker")).toBeUndefined();
  });
  it("contains exactly the sourced seven components with quantities 1/1/1/1/5/5/5", () => {
    expect(pkg.components.map((c) => [c.sku, c.qtyPerUnit])).toEqual([
      ["QCA00003", 1], ["NQ1380", 1], ["NQ2784", 1], ["NQ2886", 1], ["NQ1386", 5], ["NYNUT", 5], ["NQ1017", 5],
    ]);
    expect(pkg.components.every((c) => c.quantityStatus === "source_fixed" && c.identity === "source_backed")).toBe(true);
  });
  it("package composition is not the engineering quantity: how many drinkers is still unverified", () => {
    const rule = GROWER_RULES.find((r) => r.itemKey === "cup_drinker")!;
    expect(rule.classification).toBe("requires_validation");
    const line = calculateGrowerHouse(TOPIGS_GROWER_INPUT).lines.find((l) => l.itemKey === "cup_drinker")!;
    expect(line.projectQuantity).toBeNull();
    expect(line.basis).toBe("awaiting_validation");
  });
  it("component quantities scale with the number of packages the (manual) override supplies", () => {
    const calc = withQty({ cup_drinker: 2 }); // 2 per unit × 12 = 24 packages
    const products = new Map(pkg.components.map((c) => [c.sku!, prod(c.sku!, 100, 10)]));
    const b = buildBudgetQuote(calc.lines, new Map(), products, opts(["cup_drinker"]));
    const line = b.lines.find((l) => l.itemKey === "cup_drinker")!;
    expect(line.status).toBe("priced");
    expect(line.components!.map((c) => c.quantity)).toEqual([24, 24, 24, 24, 120, 120, 120]);
  });
});

describe("FORTIS lighting package", () => {
  const pkg = packageFor("led_light")!;
  it("resolves as a package with HNQ7046 as the sourced luminaire (×1) and clip ×3, cable ×1", () => {
    expect(commercialMappingFor("led_light")?.kind).toBe("package");
    const [lum, clip, cable] = pkg.components;
    expect(lum).toMatchObject({ sku: "HNQ7046", qtyPerUnit: 1, identity: "source_backed" });
    expect(clip).toMatchObject({ id: "clip", qtyPerUnit: 3 });
    expect(cable).toMatchObject({ id: "cable", qtyPerUnit: 1 });
  });
  it("clip/cable identity stays UNRESOLVED — no SKU assigned, both contenders listed", () => {
    const clip = pkg.components.find((c) => c.id === "clip")!;
    const cable = pkg.components.find((c) => c.id === "cable")!;
    for (const c of [clip, cable]) {
      expect(c.sku).toBeNull();
      expect(c.identity).toBe("uncertain");
      expect([...(c.candidateSkus ?? [])].sort()).toEqual(["HNQ7088", "HNQ7093"]);
    }
  });
  it("an unresolved component keeps the package INCOMPLETE and it adds nothing to totals", () => {
    const calc = withQty({ led_light: 1 });
    const products = new Map([["HNQ7046", prod("HNQ7046", 484, 900)], ["HNQ7088", prod("HNQ7088", 18, 30)], ["HNQ7093", prod("HNQ7093", 9, 15)]]);
    const b = buildBudgetQuote(calc.lines, new Map(), products, opts(["led_light"]));
    const line = b.lines.find((l) => l.itemKey === "led_light")!;
    expect(line.status).toBe("package_incomplete");
    expect(line.components!.filter((c) => c.status === "identity_unresolved").map((c) => c.id)).toEqual(["clip", "cable"]);
    expect(line.revenueExTax).toBeNull();
    expect(b.totals.subtotalExTax).toBe(0);
    expect(b.state).toBe("awaiting_pricing");
  });
});

describe("M75 Flex package", () => {
  const pkg = packageFor("flex_auger")!;
  it("resolves as a package of the ~12 sourced components", () => {
    expect(commercialMappingFor("flex_auger")?.kind).toBe("package");
    expect(pkg.components).toHaveLength(12);
    const skus = pkg.components.map((c) => c.sku);
    expect(skus).toEqual(expect.arrayContaining(["NQ1163", "NQ1984", "NQ.TUBE.63", "T3750001", "TSA3750505", "TRA1.1KW3PH"]));
  });
  it("historic Topigs quantities are references, NOT verified engineering rules", () => {
    expect(pkg.components.every((c) => c.quantityStatus === "requires_validation" && c.qtyPerUnit === null)).toBe(true);
    expect(pkg.components.find((c) => c.sku === "NQ1163")!.historicTopigsQty).toBe(134);
    expect(pkg.components.find((c) => c.sku === "NQ1984")!.historicTopigsQty).toBe(18);
    expect(GROWER_RULES.find((r) => r.itemKey === "flex_auger")!.classification).toBe("requires_validation");
  });
  it("the unsettled support post is not assigned a SKU; two SKUs are flagged as missing from Cin7", () => {
    const post = pkg.components.find((c) => c.id === "post")!;
    expect(post.sku).toBeNull();
    expect(post.candidateSkus).toEqual(["NQ2601"]);
    expect(pkg.components.filter((c) => c.note?.includes("NOT found in Cin7")).map((c) => c.sku).sort()).toEqual(["NQ.TUBE.63", "TRA1.1KW3PH"]);
  });
  it("historic quantities are never priced: even with every price present the package stays incomplete", () => {
    const calc = withQty({ flex_auger: 1 });
    const products = new Map(pkg.components.filter((c) => c.sku).map((c) => [c.sku!, prod(c.sku!, 100, 10)]));
    const b = buildBudgetQuote(calc.lines, new Map(), products, opts(["flex_auger"]));
    const line = b.lines.find((l) => l.itemKey === "flex_auger")!;
    expect(line.status).toBe("package_incomplete");
    expect(line.components!.every((c) => c.status !== "priced")).toBe(true);
    expect(b.totals.subtotalExTax).toBe(0);
  });
});

describe("PP Green penning package", () => {
  const pkg = packageFor("penning_package")!;
  it("resolves as a layout-driven package; fuzzy candidates are components, not alternatives", () => {
    expect(commercialMappingFor("penning_package")?.kind).toBe("package");
    expect(pkg.layoutDriven).toBe(true);
    expect(recommendedSkuFor("penning_package")).toBeUndefined();
  });
  it("quantities are layout-dependent and REQUIRE VALIDATION; KNQ074 ×20 is a historic reference only", () => {
    expect(pkg.components.every((c) => c.quantityStatus === "requires_validation" && c.qtyPerUnit === null)).toBe(true);
    expect(pkg.components.find((c) => c.sku === "KNQ074")!.historicTopigsQty).toBe(20);
    expect(GROWER_RULES.find((r) => r.itemKey === "penning_package")!.classification).toBe("requires_validation");
  });
  it("the panel SKU is not invented", () => {
    expect(pkg.components.find((c) => c.id === "panels")!.sku).toBeNull();
  });
});

describe("door and manual lines", () => {
  it("the PVC SST door remains unresolved — no mapping manufactured", () => {
    const m = commercialMappingFor("pvc_door");
    expect(m?.kind).toBe("unresolved");
    expect(recommendedSkuFor("pvc_door")).toBeUndefined();
    expect(packageFor("pvc_door")).toBeUndefined();
  });
  it("slat delivery is a separate manual line, distinct from the physical SKU NQ1161", () => {
    const [d] = manualLinesFor("concrete_slat");
    expect(d).toMatchObject({ kind: "manual", id: "concrete_slat_delivery", linkedItemKey: "concrete_slat", historicTopigsPerUnitZar: 51.22 });
    expect(recommendedSkuFor("concrete_slat")!.recommendedSku).toBe("NQ1161");
    expect(MANUAL_COMMERCIAL_LINES.map((m) => m.id)).toEqual(["concrete_slat_delivery"]);
  });
  it("a priced slat still lists the unpriced delivery as a blocker — delivery is never folded into the SKU", () => {
    const calc = withQty({ concrete_slat: 1 });
    const map = new Map([["concrete_slat", resolveMapping("concrete_slat", [], "NQ1161", new Set(["NQ1161"]))]]);
    const b = buildBudgetQuote(calc.lines, map, new Map([["NQ1161", prod("NQ1161", 170.29, 254)]]), opts());
    expect(b.lines.find((l) => l.itemKey === "concrete_slat")!.status).toBe("priced");
    expect(b.blockers.some((x) => x.includes("Concrete slat delivery") && x.includes("separate from the SKU"))).toBe(true);
    expect(b.state).toBe("partial");
  });
});

describe("package commercial behaviour", () => {
  const drinker = packageFor("cup_drinker")!;
  const all = (cost: number | null, price: number | null) => new Map(drinker.components.map((c) => [c.sku!, prod(c.sku!, cost, price)]));
  const calc = withQty({ cup_drinker: 1 });

  it("an unconfirmed package is not priced — it awaits confirmation", () => {
    const b = buildBudgetQuote(calc.lines, new Map(), all(100, 10), opts());
    expect(b.lines.find((l) => l.itemKey === "cup_drinker")!.status).toBe("package_unconfirmed");
    expect(b.totals.subtotalExTax).toBe(0);
    expect(b.state).toBe("awaiting_pricing");
  });
  it("a missing component price makes the package incomplete — never zero", () => {
    const products = all(100, 10);
    products.set("NQ1380", prod("NQ1380", 100, null));
    const b = buildBudgetQuote(calc.lines, new Map(), products, opts(["cup_drinker"]));
    const line = b.lines.find((l) => l.itemKey === "cup_drinker")!;
    expect(line.status).toBe("package_incomplete");
    expect(line.revenueExTax).toBeNull();
    expect(line.components!.find((c) => c.sku === "NQ1380")!.status).toBe("no_price");
    expect(b.totals.subtotalExTax).toBe(0);
  });
  it("a component absent from Cin7 is reported as not_in_catalogue", () => {
    const products = all(100, 10);
    products.delete("NQ2784");
    const b = buildBudgetQuote(calc.lines, new Map(), products, opts(["cup_drinker"]));
    expect(b.lines.find((l) => l.itemKey === "cup_drinker")!.components!.find((c) => c.sku === "NQ2784")!.status).toBe("not_in_catalogue");
  });
  it("a fully priced package is the sum of its components, via the existing engine", () => {
    const b = buildBudgetQuote(calc.lines, new Map(), all(4, 10), opts(["cup_drinker"]));
    const line = b.lines.find((l) => l.itemKey === "cup_drinker")!;
    // per drinker: 4 singles + 3 × 5 = 19 component units; ×12 packages; price 10, cost 4
    expect(line.status).toBe("priced");
    expect(line.revenueExTax).toBeCloseTo(12 * (4 + 15) * 10, 6);
    expect(b.totals.subtotalExTax).toBeCloseTo(line.revenueExTax!, 6);
    expect(b.totals.estimatedCost).toBeCloseTo(12 * 19 * 4, 6);
    expect(b.totals.overallMarginPct).toBeCloseTo(60, 6);
  });
  it("placeholder cost 50 / stock 1000 are flagged SUSPECT, not trusted", () => {
    expect(costTrust(50)).toBe("suspect");
    expect(costTrust(170.29)).toBe("unknown");
    expect(costTrust(null)).toBe("missing");
    expect(availabilityTrust(1000)).toBe("suspect");
    expect(availabilityTrust(9638)).toBe("unknown");
    const b = buildBudgetQuote(calc.lines, new Map(), all(50, 10), opts(["cup_drinker"]));
    expect(b.warnings.some((w) => w.includes("placeholder"))).toBe(true);
    expect(b.lines.find((l) => l.itemKey === "cup_drinker")!.components!.every((c) => c.costTrust === "suspect")).toBe(true);
  });
  it("historic Topigs pricing is NOT used: with no current price, totals stay empty", () => {
    const b = buildBudgetQuote(withQty({ cup_drinker: 1, feeder: 1 }).lines, new Map(), new Map(), opts(["cup_drinker"]));
    expect(b.totals.subtotalExTax).toBe(0);
    expect(b.state).toBe("awaiting_pricing");
  });
});

describe("model integrity", () => {
  it("package components never carry a price or cost (those come from Cin7 at run time)", () => {
    expect(JSON.stringify(COMMERCIAL_MAPPINGS)).not.toMatch(/"(unitPrice|averageCost|price|cost)"/);
  });
  it("a component quantity is only set when it is a source-fixed composition", () => {
    for (const m of Object.values(COMMERCIAL_MAPPINGS)) {
      if (m?.kind !== "package") continue;
      for (const c of m.components) expect(c.qtyPerUnit != null).toBe(c.quantityStatus === "source_fixed");
    }
  });
  it("every item keeps its engineering rule classification (commercial mapping changes none)", () => {
    expect(GROWER_RULES.filter((r) => r.classification === "verified")).toEqual([]);
  });
});
