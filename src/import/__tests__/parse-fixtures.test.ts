import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsv } from "@/import/csv";
import { productCsvRowSchema, toCanonicalProduct, toCanonicalPriceTiers } from "@/model/products";
import { assemblyBomCsvRowSchema, toCanonicalAssemblyBomLine } from "@/model/assembly-bom";
import {
  productionBomCsvRowSchema,
  toCanonicalVersion,
  toCanonicalOperation,
  toCanonicalItem,
  dedupeBy,
} from "@/model/production-bom";

const fixture = (name: string) => readFileSync(resolve(__dirname, "../../../docs/cin7-templates", name), "utf8");

describe("InventoryList (products) CSV", () => {
  const csv = fixture("InventoryList_2026-07-03.csv");

  it("parses every data row with no validation errors", () => {
    const { valid, invalid } = parseCsv(csv, productCsvRowSchema);
    expect(invalid).toEqual([]);
    expect(valid.length).toBeGreaterThan(0);
  });

  it("maps a known row to the canonical product shape", () => {
    const { valid } = parseCsv(csv, productCsvRowSchema);
    const row = valid.find((r) => r.data.ProductCode === "P34-300-SWPC-DEMO")!;
    const product = toCanonicalProduct(row.data);
    expect(product.sku).toBe("P34-300-SWPC-DEMO");
    expect(product.barcode).toBe("810127745896");
    expect(product.active).toBe(true);
    expect(product.status).toBe("ACTIVE");
  });

  it("only emits price tiers with a positive amount", () => {
    const { valid } = parseCsv(csv, productCsvRowSchema);
    for (const row of valid) {
      const tiers = toCanonicalPriceTiers(row.data);
      expect(tiers.every((t) => t.amount > 0)).toBe(true);
    }
  });
});

describe("AssemblyBOM CSV", () => {
  const csv = fixture("AssemblyBOM_2026-07-03.csv");

  it("parses every data row with no validation errors", () => {
    const { valid, invalid } = parseCsv(csv, assemblyBomCsvRowSchema);
    expect(invalid).toEqual([]);
    expect(valid.length).toBeGreaterThan(0);
  });

  it("maps a service component line (Labour) correctly", () => {
    const { valid } = parseCsv(csv, assemblyBomCsvRowSchema);
    const row = valid.find((r) => r.data.ProductSKU === "DRESS-001" && r.data.ComponentSKU === "LAB-001")!;
    const line = toCanonicalAssemblyBomLine(row.data);
    expect(line.expense_account).toBe("310: Credit Card Fees (No VAT)");
    expect(line.price_tier).toBe("Retail in VAT");
  });
});

describe("ProductionBOM CSV", () => {
  const csv = fixture("ProductionBOM_2026-07-03.csv");

  it("parses every data row with no validation errors", () => {
    const { valid, invalid } = parseCsv(csv, productionBomCsvRowSchema);
    expect(invalid).toEqual([]);
    expect(valid.length).toBeGreaterThan(0);
  });

  it("groups multiple component/resource rows under one operation", () => {
    const { valid } = parseCsv(csv, productionBomCsvRowSchema);
    const rows = valid.map((r) => r.data).filter((r) => r.ProductSKU === "FACEBULK001");

    const versions = dedupeBy(rows.map(toCanonicalVersion), (v) => [v.product_sku, v.version]);
    const operations = dedupeBy(rows.map(toCanonicalOperation), (o) => [o.product_sku, o.version, o.operation_sequence]);
    const items = rows.map(toCanonicalItem);

    expect(versions).toHaveLength(1);
    expect(operations).toHaveLength(2); // Mixing (seq 1) + Blending (seq 2)
    expect(items.length).toBe(rows.length); // one item row per CSV row

    const mixing = operations.find((o) => o.operation_sequence === "1")!;
    expect(mixing.work_centre_code).toBe("MIXING");
    const blending = operations.find((o) => o.operation_sequence === "2")!;
    expect(blending.previous_step).toBe("Mixing");
  });

  it("distinguishes Component vs Resource item rows", () => {
    const { valid } = parseCsv(csv, productionBomCsvRowSchema);
    const rows = valid.map((r) => r.data).filter((r) => r.ProductSKU === "FACEBULK001");
    const items = rows.map(toCanonicalItem);
    expect(items.some((i) => i.item_type === "Component" && i.item_code === "RAW0001")).toBe(true);
    expect(items.some((i) => i.item_type === "Resource" && i.item_code === "MACH001")).toBe(true);
  });
});
