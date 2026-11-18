import type { QuoteEvaluation } from "../grower/evaluate";
import type { PricedBy } from "../grower/quote-bridge";
import type { PriceSourceDescriptor, QuoteType } from "../grower/pricing-source";
import type { QuoteDraft } from "../grower/draft";
import { POC_TAX } from "../grower/final-feedback";
import { neutralPriceText } from "../grower/pricing-source";
import { hashOf } from "../quote/baseline";
import { completenessOf, type PricingCompleteness } from "./pricing-feedback";
import { currentPricingRuleSet, type PricingRuleSetDescriptor } from "./rule-set";

// THE INDICATIVE PRICE SNAPSHOT (NQ-008A): what the Rep's indicative price WAS at the moment of handoff, and the basis it was calculated on. Pure; no I/O.
// Captured once per handoff (see migration 0123: append-only, written in the same transaction as the state change) and never recalculated: a later price,
// rule or draft change can only ever be compared AGAINST it. It records nothing the engine did not already produce; it adds no formula.
//
// Two sections, because they have different audiences:
//   customerSafe  what the Rep could see - selling prices, quantities, completeness, totals. Nothing here names a cost, ROE, freight or markup.
//   internal      the calculation basis - rule set + version, price source (id, provenance, fingerprint), per-line estimated cost. Cost-entitled roles only.

export const INDICATIVE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface SnapshotLine {
  itemKey: string;
  label: string;
  status: string;
  sku: string | null;
  quantity: number | null;
  unitPriceExVat: number | null;
  /** null = NOT PRICED. A missing price is never recorded as 0. */
  revenueCents: number | null;
  pricedBy: PricedBy | null;
}
export interface SnapshotCharge { key: string; label: string; amountCents: number | null; status: "entered" | "required" }

export interface IndicativeSnapshot {
  schemaVersion: typeof INDICATIVE_SNAPSHOT_SCHEMA_VERSION;
  customerSafe: {
    quoteRef: string;
    revision: number;
    quoteType: QuoteType;
    completeness: PricingCompleteness;
    /** What was still outstanding when the Rep handed it off (plain price-list words). */
    awaiting: string[];
    lines: SnapshotLine[];
    charges: SnapshotCharge[];
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    taxRule: string;
    taxRateBps: number;
    taxInclusive: boolean;
  };
  internal: {
    ruleSet: PricingRuleSetDescriptor;
    priceSource: PriceSourceDescriptor;
    pricingBasis: string;
    /** Estimated (landed) cost per line, null where unknown. Never 0 for unknown. */
    lineCosts: { itemKey: string; estimatedCostCents: number | null; reason: string }[];
    estimatedCostCents: number;
  };
}

/** The indexed facts stored beside the snapshot so the source and rule version can be found without opening the JSON. */
export interface IndicativeSnapshotIndex {
  rulesetId: string;
  rulesetVersion: string;
  priceSourceId: string;
  /** The price source's own identity of record: its provenance line (file, sheet, date and a content hash prefix for the POC workbook). */
  priceSourceFingerprint: string;
  totalExVatCents: number;
  completeness: PricingCompleteness;
}

const cents = (rands: number | null | undefined): number | null => (rands == null || !Number.isFinite(rands) ? null : Math.round(rands * 100));

export interface SnapshotInput {
  quoteRef: string;
  revision: number;
  draft: QuoteDraft;
  /** The draft evaluated as the REP sees it (cost withheld). */
  repEvaluation: QuoteEvaluation;
  /** The SAME draft evaluated with cost visible. Used only for the internal section; its selling figures must equal the Rep's. */
  internalEvaluation: QuoteEvaluation;
}

export function buildIndicativeSnapshot(i: SnapshotInput): { snapshot: IndicativeSnapshot; hash: string; index: IndicativeSnapshotIndex } {
  const rep = i.repEvaluation.budget;
  const int = i.internalEvaluation.budget;
  if (!rep || !int) throw new Error("Nothing is priced yet, so there is no indicative price to capture.");
  if (Math.round(rep.totals.subtotalExTax * 100) !== Math.round(int.totals.subtotalExTax * 100)) throw new Error("The cost-visible evaluation does not match the quote the Rep saw.");
  const completeness = completenessOf(rep);
  const subtotalCents = Math.round(rep.totals.subtotalExTax * 100);
  const ruleSet = currentPricingRuleSet();

  const snapshot: IndicativeSnapshot = {
    schemaVersion: INDICATIVE_SNAPSHOT_SCHEMA_VERSION,
    customerSafe: {
      quoteRef: i.quoteRef,
      revision: i.revision,
      quoteType: i.draft.quoteType,
      completeness,
      awaiting: rep.blockers.map(neutralPriceText),
      lines: rep.lines.map((l) => ({
        itemKey: l.itemKey, label: l.label, status: l.status, sku: l.sku, quantity: l.quantity,
        unitPriceExVat: l.status === "priced" ? l.unitPrice : null, revenueCents: l.status === "priced" ? cents(l.revenueExTax) : null, pricedBy: l.pricedBy,
      })),
      charges: rep.charges.map((c) => ({ key: c.key, label: c.label, amountCents: c.amountExTax == null ? null : cents(c.amountExTax), status: c.status })),
      subtotalCents,
      taxCents: cents(rep.totals.taxTotal) ?? 0,
      totalCents: cents(rep.totals.totalIncTax) ?? 0,
      taxRule: POC_TAX.rule, taxRateBps: POC_TAX.rateBps, taxInclusive: POC_TAX.inclusive,
    },
    internal: {
      ruleSet,
      priceSource: int.priceSource,
      pricingBasis: int.pricingBasis,
      lineCosts: int.lines.map((l) => ({ itemKey: l.itemKey, estimatedCostCents: cents(l.estimatedCost), reason: l.reason })),
      estimatedCostCents: cents(int.totals.estimatedCost) ?? 0,
    },
  };
  return {
    snapshot,
    hash: hashOf(snapshot),
    index: {
      rulesetId: ruleSet.id,
      rulesetVersion: ruleSet.version,
      priceSourceId: int.priceSource.id,
      priceSourceFingerprint: int.priceSource.provenance,
      totalExVatCents: subtotalCents,
      completeness,
    },
  };
}

/** What a viewer WITHOUT cost visibility may be given of a stored snapshot: the customer-safe section only. */
export const repViewOf = (s: IndicativeSnapshot): IndicativeSnapshot["customerSafe"] => s.customerSafe;
