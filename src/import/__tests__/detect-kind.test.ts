import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { detectKindMismatch, KIND_COLUMNS } from "@/import/detect-kind";

const fixtureHeaders = (name: string) => {
  const csv = readFileSync(resolve(__dirname, "../../../docs/cin7-templates", name), "utf8");
  return Papa.parse(csv, { header: true }).meta.fields ?? [];
};

// Real exports (used by parse-fixtures.test.ts too) — the true, full header
// row Cin7 actually produces for these three kinds.
const PRODUCTS_HEADERS = fixtureHeaders("InventoryList_2026-07-03.csv");
const ASSEMBLY_BOM_HEADERS = fixtureHeaders("AssemblyBOM_2026-07-03.csv");
const PRODUCTION_BOM_HEADERS = fixtureHeaders("ProductionBOM_2026-07-03.csv");

// No real Supplier/Customer export fixture exists yet, so build the header
// row directly from the same full column list the detector scores against
// — Cin7 always writes every template column (blank or not), so this is
// what a genuine export's header row looks like.
const CUSTOMERS_HEADERS = KIND_COLUMNS.customers;
const SUPPLIERS_HEADERS = KIND_COLUMNS.suppliers;
const SUPPLIER_ADDRESSES_HEADERS = KIND_COLUMNS.supplier_addresses;
const CUSTOMER_ADDRESSES_HEADERS = KIND_COLUMNS.customer_addresses;

describe("detectKindMismatch", () => {
  it("returns null when the file's headers match the selected kind", () => {
    expect(detectKindMismatch(PRODUCTS_HEADERS, "products")).toBeNull();
    expect(detectKindMismatch(CUSTOMERS_HEADERS, "customers")).toBeNull();
  });

  it("catches a Customers file uploaded as Products — the real-world case that prompted this check", () => {
    const result = detectKindMismatch(CUSTOMERS_HEADERS, "products");
    expect(result).not.toBeNull();
    // Suppliers ties in too — nearly every Supplier column is also a
    // Customer column (see the tied-match test below), so a genuine
    // Customers file can't be told apart from Suppliers by headers alone.
    // The point of this test is that "products" is correctly ruled out.
    expect(result!.bestKinds.slice().sort()).toEqual(["customers", "suppliers"]);
    // Products shares its generic AdditionalAttributeN/DimensionAttributeN
    // columns with Customers, so its score isn't near-zero — but the gap to
    // the real match is still enormous, which is what actually drives
    // detection (selectedKind not being in bestKinds).
    expect(result!.bestScorePercent).toBeGreaterThan(90);
    expect(result!.bestScorePercent - result!.selectedScorePercent).toBeGreaterThan(60);
  });

  it("does not warn for suppliers vs customers — the two templates share almost every column, so treat as tied", () => {
    // A genuine Suppliers file: the only supplier-specific column present is AccountPayable.
    expect(detectKindMismatch(SUPPLIERS_HEADERS, "suppliers")).toBeNull();
  });

  it("catches a Products file uploaded as Suppliers (unrelated column set, not a tie)", () => {
    const result = detectKindMismatch(PRODUCTS_HEADERS, "suppliers");
    expect(result).not.toBeNull();
    expect(result!.bestKinds).toEqual(["products"]);
  });

  it("distinguishes Assembly BOM from Production BOM despite shared ProductSKU/Quantity columns", () => {
    expect(detectKindMismatch(PRODUCTION_BOM_HEADERS, "assembly_bom")).not.toBeNull();
    expect(detectKindMismatch(PRODUCTION_BOM_HEADERS, "production_bom")).toBeNull();
    expect(detectKindMismatch(ASSEMBLY_BOM_HEADERS, "production_bom")).not.toBeNull();
    expect(detectKindMismatch(ASSEMBLY_BOM_HEADERS, "assembly_bom")).toBeNull();
  });

  it("does not warn for supplier_addresses vs customer_addresses when IsParent is present — genuinely ambiguous, both score equally", () => {
    expect(detectKindMismatch(CUSTOMER_ADDRESSES_HEADERS, "supplier_addresses")).toBeNull();
    expect(detectKindMismatch(CUSTOMER_ADDRESSES_HEADERS, "customer_addresses")).toBeNull();
  });

  it("leans supplier_addresses when IsParent is absent — Cin7 exports the full template header, so a missing column is real signal", () => {
    const result = detectKindMismatch(SUPPLIER_ADDRESSES_HEADERS, "customer_addresses");
    expect(result).not.toBeNull();
    expect(result!.bestKinds).toEqual(["supplier_addresses"]);
  });

  it("catches an addresses file uploaded as Customers (Name-only vs Name+AddressType shape)", () => {
    const result = detectKindMismatch(SUPPLIER_ADDRESSES_HEADERS, "customers");
    expect(result).not.toBeNull();
    expect(result!.bestKinds).toContain("supplier_addresses");
  });

  it("stays quiet on an empty header list — nothing to compare", () => {
    expect(detectKindMismatch([], "products")).toBeNull();
  });

  it("stays quiet when the file doesn't clearly resemble any known template", () => {
    const headers = ["SomeRandomColumn", "AnotherOne"];
    expect(detectKindMismatch(headers, "products")).toBeNull();
  });
});
