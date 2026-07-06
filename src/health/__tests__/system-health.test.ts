import { describe, expect, it } from "vitest";
import {
  findOverdueSales,
  findOverduePurchases,
  findStuckTransfers,
  findIncompleteAssemblies,
  findBehindProductionOrders,
  runSystemHealth,
} from "@/health/system-health";
import type { ProductAuditResult } from "@/audit/product-audit";

const NOW = new Date("2026-07-06T00:00:00Z");

function emptyAudit(): ProductAuditResult {
  return {
    issues: [],
    duplicateCategories: [],
    duplicateBrands: [],
    duplicateUOMs: [],
    duplicateTags: [],
    attributeGaps: [],
    categories: [],
    products: [],
  };
}

describe("findOverdueSales", () => {
  it("flags a NOT FULFILLED sale whose ShipBy has passed", () => {
    const result = findOverdueSales([{ SaleID: "s1", FulFilmentStatus: "NOT FULFILLED", ShipBy: "2020-01-01" }], NOW);
    expect(result).toHaveLength(1);
    expect(result[0].saleId).toBe("s1");
  });

  it("flags PARTIALLY FULFILLED the same as NOT FULFILLED", () => {
    const result = findOverdueSales([{ SaleID: "s1", FulFilmentStatus: "PARTIALLY FULFILLED", ShipBy: "2020-01-01" }], NOW);
    expect(result).toHaveLength(1);
  });

  it("does not flag a FULFILLED sale even with a past ShipBy", () => {
    const result = findOverdueSales([{ SaleID: "s1", FulFilmentStatus: "FULFILLED", ShipBy: "2020-01-01" }], NOW);
    expect(result).toEqual([]);
  });

  it("does not flag an unfulfilled sale with no ShipBy set — nothing to be 'past'", () => {
    const result = findOverdueSales([{ SaleID: "s1", FulFilmentStatus: "NOT FULFILLED", ShipBy: null }], NOW);
    expect(result).toEqual([]);
  });

  it("does not flag an unfulfilled sale whose ShipBy is still in the future", () => {
    const result = findOverdueSales([{ SaleID: "s1", FulFilmentStatus: "NOT FULFILLED", ShipBy: "2027-01-01" }], NOW);
    expect(result).toEqual([]);
  });
});

describe("findOverduePurchases", () => {
  it("flags NOT RECEIVED and PARTIALLY RECEIVED purchases whose RequiredBy has passed", () => {
    const result = findOverduePurchases(
      [
        { ID: "p1", CombinedReceivingStatus: "NOT RECEIVED", RequiredBy: "2020-01-01" },
        { ID: "p2", CombinedReceivingStatus: "PARTIALLY RECEIVED", RequiredBy: "2020-01-01" },
      ],
      NOW
    );
    expect(result.map((p) => p.purchaseId)).toEqual(["p1", "p2"]);
  });

  it("does not flag FULLY RECEIVED even with a past RequiredBy", () => {
    const result = findOverduePurchases([{ ID: "p1", CombinedReceivingStatus: "FULLY RECEIVED", RequiredBy: "2020-01-01" }], NOW);
    expect(result).toEqual([]);
  });

  it("does not flag NOT AVAILABLE or blank status even with a past RequiredBy — these mean 'not applicable', not 'outstanding'", () => {
    const result = findOverduePurchases(
      [
        { ID: "p1", CombinedReceivingStatus: "NOT AVAILABLE", RequiredBy: "2020-01-01" },
        { ID: "p2", CombinedReceivingStatus: "", RequiredBy: "2020-01-01" },
      ],
      NOW
    );
    expect(result).toEqual([]);
  });
});

describe("findStuckTransfers", () => {
  it("flags DRAFT, ORDERED, and IN TRANSIT", () => {
    const result = findStuckTransfers([
      { TaskID: "t1", Status: "DRAFT" },
      { TaskID: "t2", Status: "ORDERED" },
      { TaskID: "t3", Status: "IN TRANSIT" },
    ]);
    expect(result.map((t) => t.taskId)).toEqual(["t1", "t2", "t3"]);
  });

  it("carries LastModifiedOn through as the reference date — Cin7 exposes no true 'created' date on this endpoint", () => {
    const result = findStuckTransfers([{ TaskID: "t1", Status: "DRAFT", LastModifiedOn: "2026-06-20T11:17:08.23Z" }]);
    expect(result[0].lastModifiedOn).toBe("2026-06-20T11:17:08.23Z");
  });

  it("does not flag COMPLETED or VOIDED", () => {
    const result = findStuckTransfers([
      { TaskID: "t1", Status: "COMPLETED" },
      { TaskID: "t2", Status: "VOIDED" },
    ]);
    expect(result).toEqual([]);
  });
});

describe("findIncompleteAssemblies", () => {
  it("flags DRAFT, AUTHORISED, and IN PROGRESS", () => {
    const result = findIncompleteAssemblies([
      { TaskID: "f1", Status: "DRAFT" },
      { TaskID: "f2", Status: "AUTHORISED" },
      { TaskID: "f3", Status: "IN PROGRESS" },
    ]);
    expect(result).toHaveLength(3);
  });

  it("carries the build/start Date through — often blank on a fresh DRAFT that hasn't started yet", () => {
    const result = findIncompleteAssemblies([{ TaskID: "f1", Status: "IN PROGRESS", Date: "2024-06-10T00:00:00" }]);
    expect(result[0].date).toBe("2024-06-10T00:00:00");
  });

  it("does not flag COMPLETED or VOIDED", () => {
    const result = findIncompleteAssemblies([
      { TaskID: "f1", Status: "COMPLETED" },
      { TaskID: "f2", Status: "VOIDED" },
    ]);
    expect(result).toEqual([]);
  });
});

describe("findBehindProductionOrders", () => {
  it("flags an open Type O order whose RequiredByDate has passed", () => {
    const result = findBehindProductionOrders([{ TaskID: "o1", Type: "O", Status: "RELEASED", RequiredByDate: "2020-01-01" }], NOW);
    expect(result).toHaveLength(1);
  });

  it("excludes Type R rows even when their status/date would otherwise match — routing sub-records, not separate orders", () => {
    const result = findBehindProductionOrders([{ TaskID: "r1", Type: "R", Status: "RELEASED", RequiredByDate: "2020-01-01" }], NOW);
    expect(result).toEqual([]);
  });

  it("does not flag COMPLETED or VOIDED orders even with a past RequiredByDate", () => {
    const result = findBehindProductionOrders(
      [
        { TaskID: "o1", Type: "O", Status: "COMPLETED", RequiredByDate: "2020-01-01" },
        { TaskID: "o2", Type: "O", Status: "VOIDED", RequiredByDate: "2020-01-01" },
      ],
      NOW
    );
    expect(result).toEqual([]);
  });

  it("does not flag an order with no RequiredByDate set", () => {
    const result = findBehindProductionOrders([{ TaskID: "o1", Type: "O", Status: "RELEASED", RequiredByDate: null }], NOW);
    expect(result).toEqual([]);
  });
});

describe("runSystemHealth", () => {
  it("combines all 6 dimensions and computes an overall score", () => {
    const result = runSystemHealth(
      {
        sales: [{ SaleID: "s1", FulFilmentStatus: "NOT FULFILLED", ShipBy: "2020-01-01" }],
        purchases: [],
        transfers: [],
        finishedGoods: [],
        productionOrders: [],
        productAudit: emptyAudit(),
      },
      NOW
    );
    expect(result.sales.flaggedCount).toBe(1);
    expect(result.sales.tone).toBe("red"); // 1/1 flagged = 100% > 15%
    expect(result.purchases.tone).toBe("green"); // nothing scanned, nothing flagged
    expect(typeof result.overallScore).toBe("number");
  });

  it("scores product data from the distinct set of flagged products, not raw issue count (a product can have multiple issues)", () => {
    const productAudit: ProductAuditResult = {
      ...emptyAudit(),
      issues: [
        { type: "missing_brand", productId: "p1", sku: "A", name: "A", category: "" },
        { type: "missing_uom", productId: "p1", sku: "A", name: "A", category: "" }, // same product, second issue
      ],
      products: [
        { productId: "p1", sku: "A", name: "A", category: "", sellable: true },
        { productId: "p2", sku: "B", name: "B", category: "", sellable: true },
      ],
    };
    const result = runSystemHealth(
      { sales: [], purchases: [], transfers: [], finishedGoods: [], productionOrders: [], productAudit },
      NOW
    );
    expect(result.productData.flaggedCount).toBe(1); // one distinct product, not two issues
    expect(result.productData.totalScanned).toBe(2);
  });

  it("breaks product data health down into named checks mirroring the Data Audit tab, not a flat product list", () => {
    const productAudit: ProductAuditResult = {
      ...emptyAudit(),
      issues: [
        { type: "missing_brand", productId: "p1", sku: "A", name: "A", category: "" },
        { type: "missing_revenue_account", productId: "p2", sku: "B", name: "B", category: "" },
        { type: "missing_cogs_account", productId: "p2", sku: "B", name: "B", category: "" },
      ],
      duplicateCategories: [{ names: [{ name: "Widgets", productCount: 2 }, { name: "Widgets ", productCount: 1 }] }],
      duplicateBrands: [{ names: [{ name: "Acme", productCount: 2 }, { name: "acme", productCount: 1 }] }],
      products: [
        { productId: "p1", sku: "A", name: "A", category: "", sellable: true },
        { productId: "p2", sku: "B", name: "B", category: "", sellable: true },
      ],
    };
    const result = runSystemHealth(
      { sales: [], purchases: [], transfers: [], finishedGoods: [], productionOrders: [], productAudit },
      NOW
    );
    expect(result.productData.items).toEqual([
      { label: "Missing Brand", count: 1, unit: "products" },
      { label: "Missing GL account mappings (Revenue/COGS)", count: 2, unit: "products" },
      { label: "Duplicate categories", count: 1, unit: "groups" },
      { label: "Duplicate brands", count: 1, unit: "groups" },
    ]);
  });

  it("omits zero-count checks from the product data breakdown entirely, rather than listing every check at 0", () => {
    const result = runSystemHealth(
      {
        sales: [],
        purchases: [],
        transfers: [],
        finishedGoods: [],
        productionOrders: [],
        productAudit: { ...emptyAudit(), products: [{ productId: "p1", sku: "A", name: "A", category: "", sellable: true }] },
      },
      NOW
    );
    expect(result.productData.items).toEqual([]);
  });

  it("returns a green tone and 100 overall score when every dimension is clean", () => {
    const result = runSystemHealth(
      {
        sales: [{ SaleID: "s1", FulFilmentStatus: "FULFILLED" }],
        purchases: [],
        transfers: [{ TaskID: "t1", Status: "COMPLETED" }],
        finishedGoods: [],
        productionOrders: [],
        productAudit: emptyAudit(),
      },
      NOW
    );
    for (const key of ["sales", "purchases", "transfers", "assemblies", "productionOrders", "productData"] as const) {
      expect(result[key].tone).toBe("green");
    }
    expect(result.overallScore).toBe(100);
  });

  it("counts production order totals using only Type O rows, not Type R sub-rows, so the denominator isn't inflated", () => {
    const result = runSystemHealth(
      {
        sales: [],
        purchases: [],
        transfers: [],
        finishedGoods: [],
        productionOrders: [
          { TaskID: "o1", Type: "O", Status: "RELEASED" },
          { TaskID: "r1", Type: "R", Status: "RELEASED" },
        ],
        productAudit: emptyAudit(),
      },
      NOW
    );
    expect(result.productionOrders.totalScanned).toBe(1);
  });
});
