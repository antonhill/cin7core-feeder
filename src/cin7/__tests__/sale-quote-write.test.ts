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
    { productSku: "SKU-1", productName: "Widget", quantity: 2, unitPrice: 100, discountPct: 0, taxRule: "Standard Rate Sales", taxRatePct: 15 },
    { productSku: "SKU-2", productName: "Gadget", quantity: 3, unitPrice: 50, discountPct: 10, taxRule: "Standard Rate Sales", taxRatePct: 15 },
  ];
  const idBySku = new Map([
    ["SKU-1", "prod-1"],
    ["SKU-2", "prod-2"],
  ]);

  it("targets the sale, is DRAFT, and has no charges when none are passed", () => {
    const body = buildQuoteBody("sale-1", lines, [], idBySku) as { SaleID: string; Status: string; AdditionalCharges: unknown[] };
    expect(body.SaleID).toBe("sale-1");
    expect(body.Status).toBe("DRAFT");
    expect(body.AdditionalCharges).toEqual([]);
  });

  it("maps each line with ProductID, TaxRule, net Total, and the COMPUTED tax (not 0)", () => {
    const body = buildQuoteBody("sale-1", lines, [], idBySku) as {
      Lines: { ProductID?: string; SKU: string; Quantity: number; Price: number; Discount: number; TaxRule: string; Tax: number; Total: number }[];
    };
    // 200 net → 30 tax at 15%
    expect(body.Lines[0]).toMatchObject({ ProductID: "prod-1", SKU: "SKU-1", Price: 100, Discount: 0, TaxRule: "Standard Rate Sales", Total: 200, Tax: 30 });
    // 50 × 3 × 0.9 = 135 net → 20.25 tax
    expect(body.Lines[1]).toMatchObject({ ProductID: "prod-2", SKU: "SKU-2", Total: 135, Tax: 20.25 });
  });

  it("builds AdditionalCharges with computed tax and the revenue account", () => {
    const charges = [{ description: "Delivery", quantity: 1, unitPrice: 50, discountPct: 0, taxRule: "Standard Rate Sales", taxRatePct: 15 }];
    const body = buildQuoteBody("s", [], charges, new Map(), { revenueAccount: "191" }) as {
      AdditionalCharges: { Description: string; Price: number; Tax: number; Total: number; TaxRule: string; Account?: string }[];
    };
    expect(body.AdditionalCharges[0]).toMatchObject({ Description: "Delivery", Price: 50, Discount: 0, Total: 50, Tax: 7.5, TaxRule: "Standard Rate Sales", Account: "191" });
  });

  it("omits the charge Account when no revenue account is known", () => {
    const charges = [{ description: "Delivery", quantity: 1, unitPrice: 50, discountPct: 0, taxRule: "T", taxRatePct: 15 }];
    const body = buildQuoteBody("s", [], charges, new Map()) as { AdditionalCharges: Record<string, unknown>[] };
    expect("Account" in body.AdditionalCharges[0]).toBe(false);
  });

  it("tax-inclusive: Total is the GROSS line total (Cin7's rule), Tax is the portion (150 incl @15% → tax 19.57)", () => {
    const body = buildQuoteBody(
      "s",
      [{ productSku: "X", productName: "X", quantity: 1, unitPrice: 150, discountPct: 0, taxRule: "T", taxRatePct: 15 }],
      [],
      new Map([["X", "id"]]),
      { taxInclusive: true },
    ) as { Lines: { Total: number; Tax: number }[] };
    expect(body.Lines[0].Total).toBe(150);
    expect(body.Lines[0].Tax).toBe(19.57);
  });

  it("a 0% tax rule produces 0 tax", () => {
    const body = buildQuoteBody(
      "s",
      [{ productSku: "X", productName: "X", quantity: 1, unitPrice: 100, discountPct: 0, taxRule: "Zero", taxRatePct: 0 }],
      [],
      new Map([["X", "id"]]),
    ) as { Lines: { Total: number; Tax: number }[] };
    expect(body.Lines[0]).toMatchObject({ Total: 100, Tax: 0 });
  });

  it("leaves ProductID undefined when the SKU isn't in the resolution map", () => {
    const body = buildQuoteBody("sale-1", lines, [], new Map()) as { Lines: { ProductID?: string }[] };
    expect(body.Lines[0].ProductID).toBeUndefined();
  });

  it("rounds the Total to 2 decimals", () => {
    const body = buildQuoteBody(
      "s",
      [{ productSku: "X", productName: "X", quantity: 1, unitPrice: 10, discountPct: 33.333, taxRule: "T", taxRatePct: 0 }],
      [],
      new Map([["X", "id"]]),
    ) as { Lines: { Total: number }[] };
    // 10 × (1 - 0.33333) = 6.6667 → 6.67
    expect(body.Lines[0].Total).toBe(6.67);
  });
});
