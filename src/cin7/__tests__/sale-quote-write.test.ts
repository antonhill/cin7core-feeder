import { describe, it, expect } from "vitest";
import { buildSaleHeaderBody, buildQuoteBody, type SaleQuoteHeaderInput, type SaleQuoteLineInput } from "@/cin7/sale-quote-write";

const baseHeader: SaleQuoteHeaderInput = {
  customer: "Anton Hill",
  location: "Waterfront",
  saleOrderDate: "2026-08-26",
  taxInclusive: false,
  taxRule: "Standard Rate Sales",
  priceTier: "Retail in VAT",
  salesRep: "Anton Hill",
  externalId: "QUOTE-abc",
};

describe("buildSaleHeaderBody", () => {
  it("sends the confirmed header fields, keeps SkipQuote false, and carries the ExternalID", () => {
    const body = buildSaleHeaderBody(baseHeader);
    expect(body).toMatchObject({
      Customer: "Anton Hill",
      Location: "Waterfront",
      SaleOrderDate: "2026-08-26",
      SkipQuote: false,
      TaxInclusive: false,
      TaxRule: "Standard Rate Sales",
      PriceTier: "Retail in VAT",
      SalesRepresentative: "Anton Hill",
      ExternalID: "QUOTE-abc",
    });
  });

  it("omits PriceTier / SalesRepresentative when not set", () => {
    const body = buildSaleHeaderBody({ ...baseHeader, priceTier: null, salesRep: null });
    expect("PriceTier" in body).toBe(false);
    expect("SalesRepresentative" in body).toBe(false);
    // Required fields still present.
    expect(body.TaxRule).toBe("Standard Rate Sales");
    expect(body.SkipQuote).toBe(false);
  });

  it("passes the tax-inclusive flag through", () => {
    expect(buildSaleHeaderBody({ ...baseHeader, taxInclusive: true }).TaxInclusive).toBe(true);
  });
});

describe("buildQuoteBody", () => {
  const lines: SaleQuoteLineInput[] = [
    { productSku: "SKU-1", productName: "Widget", quantity: 2, unitPrice: 100, discountPct: 0, taxRule: "Standard Rate Sales" },
    { productSku: "SKU-2", productName: "Gadget", quantity: 3, unitPrice: 50, discountPct: 10, taxRule: "Standard Rate Sales" },
  ];
  const idBySku = new Map([
    ["SKU-1", "prod-1"],
    ["SKU-2", "prod-2"],
  ]);

  it("targets the sale, is DRAFT, and carries no additional charges", () => {
    const body = buildQuoteBody("sale-1", lines, idBySku) as { SaleID: string; Status: string; AdditionalCharges: unknown[] };
    expect(body.SaleID).toBe("sale-1");
    expect(body.Status).toBe("DRAFT");
    expect(body.AdditionalCharges).toEqual([]);
  });

  it("maps each line with its resolved ProductID, TaxRule, and a net ex-discount Total", () => {
    const body = buildQuoteBody("sale-1", lines, idBySku) as {
      Lines: { ProductID?: string; SKU: string; Quantity: number; Price: number; Discount: number; TaxRule: string; Total: number }[];
    };
    expect(body.Lines[0]).toMatchObject({ ProductID: "prod-1", SKU: "SKU-1", Quantity: 2, Price: 100, Discount: 0, TaxRule: "Standard Rate Sales", Total: 200 });
    // 50 × 3 × (1 - 10%) = 135
    expect(body.Lines[1]).toMatchObject({ ProductID: "prod-2", SKU: "SKU-2", Quantity: 3, Price: 50, Discount: 10, Total: 135 });
  });

  it("leaves ProductID undefined when the SKU isn't in the resolution map", () => {
    const body = buildQuoteBody("sale-1", lines, new Map()) as { Lines: { ProductID?: string }[] };
    expect(body.Lines[0].ProductID).toBeUndefined();
  });

  it("rounds the Total to 2 decimals", () => {
    const body = buildQuoteBody(
      "s",
      [{ productSku: "X", productName: "X", quantity: 1, unitPrice: 10, discountPct: 33.333, taxRule: "T" }],
      new Map([["X", "id"]]),
    ) as { Lines: { Total: number }[] };
    // 10 × (1 - 0.33333) = 6.6667 → 6.67
    expect(body.Lines[0].Total).toBe(6.67);
  });
});
