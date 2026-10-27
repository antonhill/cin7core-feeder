// Projects POC — the ApprovedCommercialBaseline adapter.
//
// A Project is created from an APPROVED commercial baseline (quote + BOM). This interface is the
// only coupling point: the NewQuip Grower configurator (unmerged) or the Toolbox Quotes module can
// each implement it later. The POC ships a deterministic fixture so nothing depends on that branch.
// The baseline is SNAPSHOTTED onto the project; later product price changes never alter it.
import type { Cents, Bps } from "./claim-engine";

export interface BaselineLine {
  /** Stable key within this baseline (used by stage allocations). */
  lineRef: string;
  sku: string | null;
  description: string;
  quantity: number;
  salesValueCents: Cents;
  /** Estimated cost from the quote; null = unknown (never treated as 0). Reference only. */
  estimatedCostCents: Cents | null;
  /** Hint for the default stage allocation (matches a suggestedStages name). */
  suggestedStageName: string | null;
}

export interface SuggestedStage {
  name: string;
  description: string;
  valueCents: Cents;
}

export interface ApprovedCommercialBaseline {
  sourceQuoteRef: string;
  sourceQuoteId: string | null;
  customer: { cin7CustomerId: string | null; name: string };
  currency: string;
  /** Agreed contract value, ex tax. */
  contractCents: Cents;
  /** Resolved tax input (never hard-coded in the engine): rule name + rate in bps. */
  taxRule: string | null;
  taxRateBps: Bps;
  taxInclusive: boolean;
  salesperson: string | null;
  lines: BaselineLine[];
  suggestedStages: SuggestedStage[];
  /**
   * Opaque origin metadata (e.g. which template/rule set/quote revision produced this baseline). The Projects engine never
   * reads it — it is stored with the snapshot so a project can always explain where its contract came from.
   */
  provenance?: Record<string, unknown> | null;
}

const R = (rands: number): Cents => rands * 100;

/** Golden POC fixture: R10m ex VAT, the six-stage Schedule of Values from the brief. */
export function goldenFixtureBaseline(): ApprovedCommercialBaseline {
  return {
    sourceQuoteRef: "FIXTURE-QUO-0001",
    sourceQuoteId: null,
    customer: { cin7CustomerId: null, name: "NewQuip Grower Project Customer (fixture)" },
    currency: "ZAR",
    contractCents: R(10_000_000),
    taxRule: "VAT 15% (fixture)",
    taxRateBps: 1500,
    taxInclusive: false,
    salesperson: "Fixture Salesperson",
    lines: [
      { lineRef: "L1", sku: "FEEDER-LINE", description: "Feeder lines", quantity: 12, salesValueCents: R(2_500_000), estimatedCostCents: R(1_700_000), suggestedStageName: "Manufacturing" },
      { lineRef: "L2", sku: "DRINKER-LINE", description: "Drinker lines", quantity: 12, salesValueCents: R(1_000_000), estimatedCostCents: R(640_000), suggestedStageName: "Manufacturing" },
      { lineRef: "L3", sku: "SILO-30T", description: "Feed silos (30t)", quantity: 4, salesValueCents: R(3_000_000), estimatedCostCents: R(2_100_000), suggestedStageName: "Manufacturing" },
      { lineRef: "L4", sku: "PENNING", description: "Penning & partitions", quantity: 1, salesValueCents: R(1_500_000), estimatedCostCents: null, suggestedStageName: "Manufacturing" },
      { lineRef: "L5", sku: null, description: "Freight — delivery to site", quantity: 6, salesValueCents: R(800_000), estimatedCostCents: R(560_000), suggestedStageName: "Delivery" },
      { lineRef: "L6", sku: null, description: "Installation labour", quantity: 1, salesValueCents: R(1_000_000), estimatedCostCents: R(620_000), suggestedStageName: "Installation" },
      { lineRef: "L7", sku: "INSTALL-CONS", description: "Installation consumables", quantity: 1, salesValueCents: R(200_000), estimatedCostCents: R(120_000), suggestedStageName: "Installation" },
    ],
    suggestedStages: [
      { name: "Deposit / Commencement", description: "Payable on contract commencement", valueCents: R(1_000_000) },
      { name: "Manufacturing", description: "Fabrication of equipment", valueCents: R(3_000_000) },
      { name: "Equipment Ready", description: "Equipment complete and ready for dispatch", valueCents: R(2_000_000) },
      { name: "Delivery", description: "Delivery to site", valueCents: R(2_000_000) },
      { name: "Installation", description: "Installation on site", valueCents: R(1_500_000) },
      { name: "Commissioning", description: "Commissioning and handover", valueCents: R(500_000) },
    ],
  };
}
