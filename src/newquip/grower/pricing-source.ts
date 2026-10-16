// PRICE SOURCE — which controlled source the budget's selling prices come from, kept explicit and swappable.
//
// The production price source of truth is UNRESOLVED (Round 3 BLOCKER): the NewQuip "Master" Excel (Cost, ROE, Freight,
// MU → Retail Price ex VAT) versus Cin7 Core. The budget engine (quote-bridge.ts) therefore never reads a source directly:
// it is handed `ProductCommercials` (see quote-bridge.ts) by whoever loaded them. Swapping the source means supplying a
// different loader and descriptor — nothing in the engine changes.
//
// For the POC / beta the loader is the org's synced Cin7 price tiers (plus the Quotes module's live per-SKU tier read).

export type PriceSourceId = "cin7_synced_price_tiers" | "newquip_master_excel" | "cin7_core_live";

export interface PriceSourceDescriptor {
  id: PriceSourceId;
  label: string;
  /** What the figures are, in plain words. */
  basis: string;
  /** True while NewQuip has not chosen this as the production source. */
  provisional: boolean;
  /** Shown beside every budget so nobody mistakes the figures for a final commercial price. */
  notice: string;
}

/** The currently validated controlled source used by the POC / internal beta. */
export const CURRENT_PRICE_SOURCE: PriceSourceDescriptor = {
  id: "cin7_synced_price_tiers",
  label: "Cin7 synced price tiers (interim)",
  basis: "Selling price = the customer's / chosen Cin7 price tier for each SKU (Sean Round 1: 'tier price').",
  provisional: true,
  notice: "Interim price source — the production source of truth (NewQuip Master Excel vs Cin7 Core) is UNRESOLVED (Round 3).",
};

/** How the rep chose to price this quote (Sean Round 1 commercial #2: 'select if this is a Day-to-day or a project'). */
export type QuoteType = "day_to_day" | "project";

export const QUOTE_TYPE_LABEL: Record<QuoteType, string> = { day_to_day: "Day-to-day", project: "Project" };

/**
 * Project pricing is UNRESOLVED: Sean said "Project = cost + 20% mark-up" but the Master proves Cost, ROE, Freight and MU
 * are distinct and MU is not universally 20%. No formula is applied — the estimator supplies the selling price.
 */
export const PROJECT_PRICING_NOTICE = "ESTIMATOR PRICING REQUIRED — Project pricing ('Cost + 20%') is not yet defined, so nothing is calculated automatically.";
