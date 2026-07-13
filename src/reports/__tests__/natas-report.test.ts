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
      { productSku: "LisbonClassic6", componentSku: "NatasCasingStd", quantity: 6, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
      { productSku: "LisbonClassic6", componentSku: "Napkin", quantity: 0.0005, estimatedUnitCost: 1200, componentCategoryCode: "Packaging" },
      { productSku: "SomeServiceSku", componentSku: "Labor", quantity: 1, estimatedUnitCost: 50, componentCategoryCode: "Ingredient" },
    ];
    const index = buildBomCostIndex(lines);
    expect(index.get("LisbonClassic6")?.casingMultiplier).toBe(6);
    expect(index.get("SomeServiceSku")?.casingMultiplier).toBe(1);
  });

  it("only counts Packaging/Label/Topping category components toward packaging cost, not the casing component itself", () => {
    const lines: BomLineInput[] = [
      { productSku: "LisbonClassic1", componentSku: "2PillowSleeve", quantity: 0.001, estimatedUnitCost: 1910, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "CinnamonSachet", quantity: 0.002, estimatedUnitCost: 73.7, componentCategoryCode: "Topping" },
      { productSku: "LisbonClassic1", componentSku: "LisbonClassicLabel", quantity: 0.001, estimatedUnitCost: 59.93, componentCategoryCode: "Label" },
      { productSku: "LisbonClassic1", componentSku: "Napkin", quantity: 0.0005, estimatedUnitCost: 1200, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "LisClassicFillStd", quantity: 0.0065, estimatedUnitCost: 318.5898, componentCategoryCode: "Fillings" },
      // Live-confirmed data quirk: NatasCasingStd is miscategorized as "Nata", not "Casing" — must not leak into packaging cost.
      { productSku: "LisbonClassic1", componentSku: "NatasCasingStd", quantity: 1, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
    ];
    const index = buildBomCostIndex(lines);
    // 0.001*1910 + 0.002*73.7 + 0.001*59.93 + 0.0005*1200 = 1.91 + 0.1474 + 0.05993 + 0.6
    expect(index.get("LisbonClassic1")?.packagingUnitCost).toBeCloseTo(2.71733, 4);
  });
});

describe("buildNatasReport", () => {
  it("extrapolates a predefined-pack sale to its individual-nata count and own packaging cost (Lisbon Classic 1 receipt)", () => {
    const bomLines: BomLineInput[] = [
      { productSku: "LisbonClassic1", componentSku: "2PillowSleeve", quantity: 0.001, estimatedUnitCost: 1910, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "CinnamonSachet", quantity: 0.002, estimatedUnitCost: 73.7, componentCategoryCode: "Topping" },
      { productSku: "LisbonClassic1", componentSku: "LisbonClassicLabel", quantity: 0.001, estimatedUnitCost: 59.93, componentCategoryCode: "Label" },
      { productSku: "LisbonClassic1", componentSku: "Napkin", quantity: 0.0005, estimatedUnitCost: 1200, componentCategoryCode: "Packaging" },
      { productSku: "LisbonClassic1", componentSku: "LisClassicFillStd", quantity: 0.0065, estimatedUnitCost: 318.5898, componentCategoryCode: "Fillings" },
      { productSku: "LisbonClassic1", componentSku: "NatasCasingStd", quantity: 1, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
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
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];

    const { rows, unmapped } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));

    expect(unmapped).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month: "2026-07", location: "Sandton", nataType: "Lisbon Classic", individualNatas: 1, revenue: 21 });
    expect(rows[0].packagingCost).toBeCloseTo(2.71733, 4);
    expect(rows[0].packagingCostPerNata).toBeCloseTo(2.71733, 4);
    expect(rows[0].profit).toBeCloseTo(21 - 2.71733, 4);
    expect(rows[0].marginPercent).toBeCloseTo(((21 - 2.71733) / 21) * 100, 4);
  });

  it("splits a mixed-pack sale's patch-packaging cost proportionally across two Nata Types in the same sale (SNTN4 receipt)", () => {
    const bomLines: BomLineInput[] = [
      // LisbonClassicSingleNata: no packaging components at all — packaging is added separately via 6NataPackaging.
      { productSku: "LisbonClassicSingleNata", componentSku: "LisClassicFillStd", quantity: 0.006521, estimatedUnitCost: 318.5898, componentCategoryCode: "Fillings" },
      { productSku: "LisbonClassicSingleNata", componentSku: "NatasCasingStd", quantity: 1, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
      // HappyBerrySingleNata: same shape, different filling.
      { productSku: "HappyBerrySingleNata", componentSku: "BerryJamFilling1Kg", quantity: 0.01, estimatedUnitCost: 56.529, componentCategoryCode: "Fillings" },
      { productSku: "HappyBerrySingleNata", componentSku: "NatasCasingStd", quantity: 1, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
      // 6NataPackaging: pure packaging bundle, no casing component.
      { productSku: "6NataPackaging", componentSku: "6PillowSleeve", quantity: 0.002, estimatedUnitCost: 1520, componentCategoryCode: "Packaging" },
      { productSku: "6NataPackaging", componentSku: "CinnamonSachet", quantity: 0.012, estimatedUnitCost: 73.7, componentCategoryCode: "Topping" },
      { productSku: "6NataPackaging", componentSku: "LisbonClassicLabel", quantity: 0.001, estimatedUnitCost: 59.93, componentCategoryCode: "Label" },
      { productSku: "6NataPackaging", componentSku: "Napkin", quantity: 0.0005, estimatedUnitCost: 1200, componentCategoryCode: "Packaging" },
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
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];

    const { rows, unmapped } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));

    expect(unmapped).toEqual([]);
    // 6NataPackaging's own BOM cost: 0.002*1520 + 0.012*73.7 + 0.001*59.93 + 0.0005*1200 = 4.58433, split 3/6 : 3/6.
    const lisbonRow = rows.find((r) => r.nataType === "Lisbon Classic");
    const happyRow = rows.find((r) => r.nataType === "Happy Berry");
    expect(lisbonRow).toMatchObject({ individualNatas: 3, revenue: 58.12 });
    expect(happyRow).toMatchObject({ individualNatas: 3, revenue: 60.88 });
    expect(lisbonRow?.packagingCost).toBeCloseTo(2.292165, 4);
    expect(happyRow?.packagingCost).toBeCloseTo(2.292165, 4);
    // Total revenue across both rows matches the real sale total (R119.00).
    expect((lisbonRow?.revenue ?? 0) + (happyRow?.revenue ?? 0)).toBeCloseTo(119, 2);
  });

  it("reports zero packaging cost for a NoPackaging pack variant with no Packaging/Label/Topping components in its own BOM and no patch line in the sale", () => {
    const bomLines: BomLineInput[] = [
      { productSku: "LisbonClassic12NoPackaging", componentSku: "LisClassicFillStd", quantity: 0.0391, estimatedUnitCost: 318.5898, componentCategoryCode: "Fillings" },
      { productSku: "LisbonClassic12NoPackaging", componentSku: "NatasCasingStd", quantity: 12, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
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
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];

    const { rows } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));
    expect(rows[0]).toMatchObject({ individualNatas: 12, packagingCost: 0, packagingCostPerNata: 0, profit: 150 });
  });

  it("reports marginPercent as null (not 0 or NaN) when revenue is 0, since the ratio is genuinely undefined", () => {
    const saleLines: NatasSaleLineInput[] = [
      {
        instanceId: "inst-1",
        cin7SaleId: "4",
        productSku: "LisbonClassic1",
        productName: "Lisbon Classic 1",
        categoryCode: "Nata",
        quantity: 1,
        total: 0,
        invoiceDate: "2026-07-12",
        location: "Sandton",
      },
    ];
    const { rows } = buildNatasReport(saleLines, buildBomCostIndex([]));
    expect(rows[0].marginPercent).toBeNull();
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
      { productSku: "LisbonClassic1", componentSku: "NatasCasingStd", quantity: 1, estimatedUnitCost: 0.4563, componentCategoryCode: "Nata" },
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
        invoiceDate: "2026-07-20",
        location: "Sandton",
      },
    ];

    const { rows } = buildNatasReport(saleLines, buildBomCostIndex(bomLines));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month: "2026-07", location: "Sandton", nataType: "Lisbon Classic", individualNatas: 3, revenue: 63 });
  });
});
