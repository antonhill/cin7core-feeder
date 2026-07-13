import { describe, expect, it } from "vitest";
import {
  buildBomCostIndex,
  buildNatasReport,
  mapNataType,
  type BomLineInput,
  type NatasSaleLineInput,
} from "@/reports/natas-report";

describe("mapNataType", () => {
  it("maps Lisbon Classic Mini before the base Lisbon Classic prefix", () => {
    expect(mapNataType("LisbonClassicMini6")).toBe("Lisbon Classic Mini");
    expect(mapNataType("LisbonClassic6")).toBe("Lisbon Classic");
  });

  it("maps Happy Berry", () => {
    expect(mapNataType("HappyBerry12")).toBe("Happy Berry");
    expect(mapNataType("HappyBerrySingleNata")).toBe("Happy Berry");
  });

  it("returns null for an unrecognized flavor prefix", () => {
    expect(mapNataType("SomeNewFlavor6")).toBeNull();
  });
});

describe("buildBomCostIndex", () => {
  it("sums casing-SKU quantity as the multiplier, defaulting to 1 when none present", () => {
    const lines: BomLineInput[] = [
      { productSku: "LisbonClassic6", componentSku: "NatasCasingStd", quantity: 6, componentAverageCost: null, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
      { productSku: "LisbonClassic6", componentSku: "Napkin", quantity: 0.0005, componentAverageCost: 1140, estimatedUnitCost: null, componentCategoryCode: "Packaging" },
      { productSku: "SomeServiceSku", componentSku: "Labor", quantity: 1, componentAverageCost: 50, estimatedUnitCost: null, componentCategoryCode: "Ingredient" },
    ];
    const index = buildBomCostIndex(lines);
    expect(index.get("LisbonClassic6")?.casingMultiplier).toBe(6);
    expect(index.get("SomeServiceSku")?.casingMultiplier).toBe(1);
  });

  it("only counts Packaging/Label/Topping category components toward packaging cost, not the casing component itself", () => {
    const lines: BomLineInput[] = [
      { productSku: "LisbonClassic1", componentSku: "2PillowSleeve", quantity: 0.001, componentAverageCost: 2.62, estimatedUnitCost: null, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "CinnamonSachet", quantity: 0.002, componentAverageCost: 67, estimatedUnitCost: null, componentCategoryCode: "Topping" },
      { productSku: "LisbonClassic1", componentSku: "LisbonClassicLabel", quantity: 0.001, componentAverageCost: 51.75, estimatedUnitCost: null, componentCategoryCode: "Label" },
      { productSku: "LisbonClassic1", componentSku: "Napkin", quantity: 0.0005, componentAverageCost: 1140, estimatedUnitCost: null, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "LisClassicFillStd", quantity: 0.0065, componentAverageCost: 318.5898, estimatedUnitCost: null, componentCategoryCode: "Fillings" },
      // Live-confirmed data quirk: NatasCasingStd is miscategorized as "Nata", not "Casing" — must not leak into packaging cost.
      { productSku: "LisbonClassic1", componentSku: "NatasCasingStd", quantity: 1, componentAverageCost: 0.4563, estimatedUnitCost: null, componentCategoryCode: "Nata" },
    ];
    const index = buildBomCostIndex(lines);
    // 0.001*2.62 + 0.002*67 + 0.001*51.75 + 0.0005*1140 = 0.00262 + 0.134 + 0.05175 + 0.57
    expect(index.get("LisbonClassic1")?.packagingUnitCost).toBeCloseTo(0.75837, 4);
  });

  it("falls back to estimatedUnitCost only when componentAverageCost is null — the live bug this exists to fix", () => {
    // Confirmed live 2026-07-13: assembly_bom_lines.estimated_unit_cost sits
    // at 0 for this org because the manual CSV round-trip that populates it
    // kept failing to import, while products.average_cost (Cin7's own
    // live-tracked cost) was correct the whole time. componentAverageCost
    // must win whenever it's available, not just be an equal-priority OR.
    const lines: BomLineInput[] = [
      { productSku: "LisbonClassic1", componentSku: "Napkin", quantity: 1, componentAverageCost: 1140, estimatedUnitCost: 0, componentCategoryCode: "Packaging" },
      { productSku: "OtherSku", componentSku: "SomeNewPackagingItem", quantity: 1, componentAverageCost: null, estimatedUnitCost: 42, componentCategoryCode: "Packaging" },
    ];
    const index = buildBomCostIndex(lines);
    expect(index.get("LisbonClassic1")?.packagingUnitCost).toBe(1140);
    expect(index.get("OtherSku")?.packagingUnitCost).toBe(42);
  });
});

describe("buildNatasReport", () => {
  it("extrapolates a predefined-pack sale to its individual-nata count, own packaging cost, and full COGS (Lisbon Classic 1 receipt)", () => {
    const bomLines: BomLineInput[] = [
      { productSku: "LisbonClassic1", componentSku: "2PillowSleeve", quantity: 0.001, componentAverageCost: 2.62, estimatedUnitCost: null, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "CinnamonSachet", quantity: 0.002, componentAverageCost: 67, estimatedUnitCost: null, componentCategoryCode: "Topping" },
      { productSku: "LisbonClassic1", componentSku: "LisbonClassicLabel", quantity: 0.001, componentAverageCost: 51.75, estimatedUnitCost: null, componentCategoryCode: "Label" },
      { productSku: "LisbonClassic1", componentSku: "Napkin", quantity: 0.0005, componentAverageCost: 1140, estimatedUnitCost: null, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "LisClassicFillStd", quantity: 0.0065, componentAverageCost: 318.5898, estimatedUnitCost: null, componentCategoryCode: "Fillings" },
      { productSku: "LisbonClassic1", componentSku: "NatasCasingStd", quantity: 1, componentAverageCost: 0.4563, estimatedUnitCost: null, componentCategoryCode: "Nata" },
    ];
    const saleLines: NatasSaleLineInput[] = [
      {
        instanceId: "inst-1",
        cin7SaleId: "1",
        productSku: "LisbonClassic1",
        productName: "Lisbon Classic 1",
        categoryCode: "Nata",
        quantity: 1,
        total: 21,
        averageCost: 5.2444,
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];

    const { rows, unmapped } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));

    expect(unmapped).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month: "2026-07", location: "Sandton", nataType: "Lisbon Classic", individualNatas: 1, revenue: 21 });
    // 0.001*2.62 + 0.002*67 + 0.001*51.75 + 0.0005*1140 = 0.75837
    expect(rows[0].packagingCost).toBeCloseTo(0.75837, 4);
    expect(rows[0].packagingCostPerNata).toBeCloseTo(0.75837, 4);
    expect(rows[0].profit).toBeCloseTo(21 - 0.75837, 4);
    expect(rows[0].marginPercent).toBeCloseTo(((21 - 0.75837) / 21) * 100, 4);
    // Full COGS uses Cin7's own average_cost, independent of the BOM-derived packaging split.
    expect(rows[0].fullCogs).toBeCloseTo(5.2444, 4);
    expect(rows[0].fullProfit).toBeCloseTo(21 - 5.2444, 4);
    expect(rows[0].fullMarginPercent).toBeCloseTo(((21 - 5.2444) / 21) * 100, 4);
  });

  it("splits a mixed-pack sale's patch-packaging cost (both BOM-derived and Cin7's own average cost) proportionally across two Nata Types in the same sale (SNTN4 receipt)", () => {
    const bomLines: BomLineInput[] = [
      // LisbonClassicSingleNata: no packaging components at all — packaging is added separately via 6NataPackaging.
      { productSku: "LisbonClassicSingleNata", componentSku: "LisClassicFillStd", quantity: 0.006521, componentAverageCost: 318.5898, estimatedUnitCost: null, componentCategoryCode: "Fillings" },
      { productSku: "LisbonClassicSingleNata", componentSku: "NatasCasingStd", quantity: 1, componentAverageCost: 0.4563, estimatedUnitCost: null, componentCategoryCode: "Nata" },
      // HappyBerrySingleNata: same shape, different filling.
      { productSku: "HappyBerrySingleNata", componentSku: "BerryJamFilling1Kg", quantity: 0.01, componentAverageCost: 56.529, estimatedUnitCost: null, componentCategoryCode: "Fillings" },
      { productSku: "HappyBerrySingleNata", componentSku: "NatasCasingStd", quantity: 1, componentAverageCost: 0.4563, estimatedUnitCost: null, componentCategoryCode: "Nata" },
      // 6NataPackaging: pure packaging bundle, no casing component.
      { productSku: "6NataPackaging", componentSku: "6PillowSleeve", quantity: 0.002, componentAverageCost: 815, estimatedUnitCost: null, componentCategoryCode: "Packaging" },
      { productSku: "6NataPackaging", componentSku: "CinnamonSachet", quantity: 0.012, componentAverageCost: 67, estimatedUnitCost: null, componentCategoryCode: "Topping" },
      { productSku: "6NataPackaging", componentSku: "LisbonClassicLabel", quantity: 0.001, componentAverageCost: 51.75, estimatedUnitCost: null, componentCategoryCode: "Label" },
      { productSku: "6NataPackaging", componentSku: "Napkin", quantity: 0.0005, componentAverageCost: 1140, estimatedUnitCost: null, componentCategoryCode: "Packaging" },
    ];
    const saleLines: NatasSaleLineInput[] = [
      {
        instanceId: "inst-1",
        cin7SaleId: "SNTN4",
        productSku: "6NataPackaging",
        productName: "6 Nata Packaging",
        categoryCode: "Packaging",
        quantity: 1,
        total: 0,
        averageCost: 4, // Cin7's own average cost for the packaging bundle — a real cost, even though it's sold at R0.
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
      {
        instanceId: "inst-1",
        cin7SaleId: "SNTN4",
        productSku: "LisbonClassicSingleNata",
        productName: "Lisbon Classic Single",
        categoryCode: "Nata",
        quantity: 3,
        total: 58.12,
        averageCost: 2.5377,
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
      {
        instanceId: "inst-1",
        cin7SaleId: "SNTN4",
        productSku: "HappyBerrySingleNata",
        productName: "Happy Berry Single",
        categoryCode: "Nata",
        quantity: 3,
        total: 60.88,
        averageCost: 3.2524,
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];

    const { rows, unmapped } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));

    expect(unmapped).toEqual([]);
    // 6NataPackaging's own BOM cost: 0.002*815 + 0.012*67 + 0.001*51.75 + 0.0005*1140 = 1.63 + 0.804 + 0.05175 + 0.57 = 3.05575, split 3/6 : 3/6.
    const lisbonRow = rows.find((r) => r.nataType === "Lisbon Classic");
    const happyRow = rows.find((r) => r.nataType === "Happy Berry");
    expect(lisbonRow).toMatchObject({ individualNatas: 3, revenue: 58.12 });
    expect(happyRow).toMatchObject({ individualNatas: 3, revenue: 60.88 });
    expect(lisbonRow?.packagingCost).toBeCloseTo(1.527875, 4);
    expect(happyRow?.packagingCost).toBeCloseTo(1.527875, 4);
    // Total revenue across both rows matches the real sale total (R119.00).
    expect((lisbonRow?.revenue ?? 0) + (happyRow?.revenue ?? 0)).toBeCloseTo(119, 2);
    // Full COGS: each single's own (quantity*averageCost) plus half of 6NataPackaging's average cost (4 * 1 / 2 = 2).
    expect(lisbonRow?.fullCogs).toBeCloseTo(3 * 2.5377 + 2, 4);
    expect(happyRow?.fullCogs).toBeCloseTo(3 * 3.2524 + 2, 4);
  });

  it("reports zero packaging cost for a NoPackaging pack variant with no Packaging/Label/Topping components in its own BOM and no patch line in the sale", () => {
    const bomLines: BomLineInput[] = [
      { productSku: "LisbonClassic12NoPackaging", componentSku: "LisClassicFillStd", quantity: 0.0391, componentAverageCost: 318.5898, estimatedUnitCost: null, componentCategoryCode: "Fillings" },
      { productSku: "LisbonClassic12NoPackaging", componentSku: "NatasCasingStd", quantity: 12, componentAverageCost: 0.4563, estimatedUnitCost: null, componentCategoryCode: "Nata" },
    ];
    const saleLines: NatasSaleLineInput[] = [
      {
        instanceId: "inst-1",
        cin7SaleId: "2",
        productSku: "LisbonClassic12NoPackaging",
        productName: "Lisbon Classic 12 (No Packaging)",
        categoryCode: "Nata",
        quantity: 1,
        total: 150,
        averageCost: 0,
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];

    const { rows } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));
    expect(rows[0]).toMatchObject({ individualNatas: 12, packagingCost: 0, packagingCostPerNata: 0, profit: 150, fullCogs: 0, fullProfit: 150 });
  });

  it("reports marginPercent/fullMarginPercent as null (not 0 or NaN) when revenue is 0, since the ratio is genuinely undefined", () => {
    const saleLines: NatasSaleLineInput[] = [
      {
        instanceId: "inst-1",
        cin7SaleId: "4",
        productSku: "LisbonClassic1",
        productName: "Lisbon Classic 1",
        categoryCode: "Nata",
        quantity: 1,
        total: 0,
        averageCost: 1,
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];
    const { rows } = buildNatasReport(saleLines, buildBomCostIndex([]));
    expect(rows[0].marginPercent).toBeNull();
    expect(rows[0].fullMarginPercent).toBeNull();
  });

  it("surfaces an unrecognized Nata-category SKU in `unmapped` instead of dropping or miscounting it", () => {
    const saleLines: NatasSaleLineInput[] = [
      {
        instanceId: "inst-1",
        cin7SaleId: "3",
        productSku: "NatasCasingStd",
        productName: "Natas Casing Standard",
        categoryCode: "Nata",
        quantity: 5,
        total: 0,
        averageCost: 0,
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];

    const { rows, unmapped } = buildNatasReport(saleLines, buildBomCostIndex([]));
    expect(rows).toEqual([]);
    expect(unmapped).toEqual([{ sku: "NatasCasingStd", name: "Natas Casing Standard", quantity: 5 }]);
  });

  it("aggregates multiple sales into one row when month/location/nataType match", () => {
    const bomLines: BomLineInput[] = [
      { productSku: "LisbonClassic1", componentSku: "NatasCasingStd", quantity: 1, componentAverageCost: 0.4563, estimatedUnitCost: null, componentCategoryCode: "Nata" },
    ];
    const saleLines: NatasSaleLineInput[] = [
      {
        instanceId: "inst-1",
        cin7SaleId: "10",
        productSku: "LisbonClassic1",
        productName: "Lisbon Classic 1",
        categoryCode: "Nata",
        quantity: 1,
        total: 21,
        averageCost: 5,
        invoiceDate: "2026-07-05",
        location: "Sandton",
      },
      {
        instanceId: "inst-1",
        cin7SaleId: "11",
        productSku: "LisbonClassic1",
        productName: "Lisbon Classic 1",
        categoryCode: "Nata",
        quantity: 2,
        total: 42,
        averageCost: 5,
        invoiceDate: "2026-07-20",
        location: "Sandton",
      },
    ];

    const { rows } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month: "2026-07", location: "Sandton", nataType: "Lisbon Classic", individualNatas: 3, revenue: 63, fullCogs: 15 });
  });
});
