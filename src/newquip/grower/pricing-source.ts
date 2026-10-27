// PRICE SOURCE — which controlled source the quote's selling prices come from, kept explicit and swappable.
//
// FINAL (Sean, 2026-10-27): "Cin7 contains demo data, so use the workbook for the POC." The POC price authority is the
// NewQuip Master workbook, loaded as a CONTROLLED SNAPSHOT of only the products the POC needs (workbook-price-source.ts).
// The quote engine (quote-bridge.ts) never reads a source directly: it is handed `ProductCommercials`, built here from
// whichever `PriceSource` is plugged in. Swapping to Cin7 Core later means supplying another PriceSource — nothing in the
// engine or the UI changes. No workbook price is scattered through UI components.

export type PriceSourceId = "newquip_master_workbook_snapshot" | "cin7_core_live";

export type QuoteType = "day_to_day" | "project";
export const QUOTE_TYPE_LABEL: Record<QuoteType, string> = { day_to_day: "Day-to-day", project: "Project" };

export interface PriceSourceDescriptor {
  id: PriceSourceId;
  /** Shown beside every quote. */
  label: string;
  /** What the figures are, in plain words. */
  basis: string;
  /** When / where the snapshot came from (provenance stays visible). */
  provenance: string;
  /** Shown beside every quote so nobody mistakes POC figures for a production price list. */
  notice: string;
}

/** The result of asking a price source for ONE product at ONE quote type. Never a silent zero. */
export type PriceResult =
  | { status: "priced"; unitPriceExVat: number; landedCostExVat: number }
  | { status: "supplier_quote_required"; reason: string }
  | { status: "not_in_source"; reason: string };

export interface PriceSource {
  descriptor: PriceSourceDescriptor;
  priceFor(sku: string, quoteType: QuoteType): PriceResult;
  /** True when the source can price this SKU at all (used for mapping existence). */
  has(sku: string): boolean;
}

/** Day-to-day = workbook Retail ex VAT. Project = landed cost + 20% (Sean): landed = Cost × ROE × Freight, NOT Retail MU + 20%. */
export const PRICING_RULE_NOTICE =
  "Day-to-day = workbook Retail Price ex VAT. Project = landed cost (Cost × ROE × Freight) + 20%.";

export const QUOTE_TYPE_BASIS: Record<QuoteType, string> = {
  day_to_day: "Workbook Retail Price ex VAT",
  project: "Landed cost (Cost × ROE × Freight) + 20% markup",
};
