import { describe, expect, it } from "vitest";
import { SALES_SOURCE, INVENTORY_MOVEMENT_SOURCE } from "@/reports/custom/sources";
import type { MeasureDef, SumMeasureDef, RatioMeasureDef } from "@/reports/custom/aggregate";
import type { InventoryMovementFactRow } from "@/reports/custom/facts";

function asSumMeasure<Row>(m: MeasureDef<Row>): SumMeasureDef<Row> {
  if (!("getValue" in m)) throw new Error(`measure ${m.key} is a ratio measure, not a sum measure`);
  return m;
}

function asRatioMeasure<Row>(m: MeasureDef<Row>): RatioMeasureDef {
  if (!("compute" in m)) throw new Error(`measure ${m.key} is a sum measure, not a ratio measure`);
  return m;
}

function findMeasure(key: string): SumMeasureDef<InventoryMovementFactRow> {
  const measure = INVENTORY_MOVEMENT_SOURCE.measures.find((m) => m.key === key);
  if (!measure) throw new Error(`missing measure ${key}`);
  return asSumMeasure(measure);
}

function factRow(overrides: Partial<InventoryMovementFactRow>): InventoryMovementFactRow {
  return { product_sku: "SKU-1", product_name: "Widget", quantity: 10, source: "purchases", movement_date: "2026-06-01", ...overrides };
}

describe("INVENTORY_MOVEMENT_SOURCE measures", () => {
  it("qty_in_purchases only counts purchase-sourced rows, zero otherwise", () => {
    const measure = findMeasure("qty_in_purchases");
    expect(measure.getValue(factRow({ source: "purchases", quantity: 10 }))).toBe(10);
    expect(measure.getValue(factRow({ source: "sales", quantity: 10 }))).toBe(0);
  });

  it("qty_out_consumption only counts assembly_consumption-sourced rows", () => {
    const measure = findMeasure("qty_out_consumption");
    expect(measure.getValue(factRow({ source: "assembly_consumption", quantity: 4 }))).toBe(4);
    expect(measure.getValue(factRow({ source: "assembly_in", quantity: 4 }))).toBe(0);
  });

  it("net_change is positive for in-sources and negative for out-sources", () => {
    const measure = findMeasure("net_change");
    expect(measure.getValue(factRow({ source: "purchases", quantity: 5 }))).toBe(5);
    expect(measure.getValue(factRow({ source: "assembly_in", quantity: 5 }))).toBe(5);
    expect(measure.getValue(factRow({ source: "sales", quantity: 5 }))).toBe(-5);
    expect(measure.getValue(factRow({ source: "assembly_consumption", quantity: 5 }))).toBe(-5);
  });

  it("product dimension groups by SKU but displays the product name", () => {
    const dim = INVENTORY_MOVEMENT_SOURCE.dimensions.find((d) => d.key === "product")!;
    const row = factRow({ product_sku: "SKU-9", product_name: "Widget 9" });
    expect(dim.getGroupKey(row)).toBe("SKU-9");
    expect(dim.getDisplayValue!(row)).toBe("Widget 9");
  });

  it("month dimension buckets by the movement date's year-month", () => {
    const dim = INVENTORY_MOVEMENT_SOURCE.dimensions.find((d) => d.key === "month")!;
    expect(dim.getGroupKey(factRow({ movement_date: "2026-06-15" }))).toBe("2026-06");
    expect(dim.getGroupKey(factRow({ movement_date: null }))).toBe("Unknown");
  });
});

describe("SALES_SOURCE dimensions", () => {
  it("falls back to a stable label when category/location/customer are null", () => {
    const category = SALES_SOURCE.dimensions.find((d) => d.key === "category")!;
    const location = SALES_SOURCE.dimensions.find((d) => d.key === "location")!;
    const customer = SALES_SOURCE.dimensions.find((d) => d.key === "customer")!;
    const row = {
      product_sku: "SKU-1",
      product_name: "Widget",
      category_code: null,
      location: null,
      customer_name: null,
      invoice_date: null,
      quantity: 1,
      revenue: 0,
      cogs: 0,
      profit: 0,
    };
    expect(category.getGroupKey(row)).toBe("Uncategorized");
    expect(location.getGroupKey(row)).toBe("Unknown");
    expect(customer.getGroupKey(row)).toBe("Unknown");
  });
});

describe("SALES_SOURCE margin_percent (ratio measure)", () => {
  const margin = () => asRatioMeasure(SALES_SOURCE.measures.find((m) => m.key === "margin_percent")!);

  it("depends on revenue and profit", () => {
    expect(margin().dependsOn).toEqual(["revenue", "profit"]);
  });

  it("computes profit/revenue as a percentage, rounded to 2 decimal places", () => {
    expect(margin().compute({ revenue: 300, profit: 110 })).toBe(36.67);
  });

  it("returns null rather than dividing by zero", () => {
    expect(margin().compute({ revenue: 0, profit: 0 })).toBeNull();
  });
});
