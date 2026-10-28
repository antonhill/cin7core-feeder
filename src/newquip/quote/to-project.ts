import type { ApprovedCommercialBaseline, BaselineLine, SuggestedStage } from "@/lib/projects/baseline";
import { POC_STAGE_SPLIT_BPS } from "../grower/final-feedback";
import type { AcceptedBaseline } from "./baseline";
import { buildPhysicalScope } from "./physical-scope";

// NewQuip Quote-to-Project ADAPTER. The NewQuip domain may know about its scope and stages; the generic Projects engine must
// not. This is the only place the two meet: it turns an ACCEPTED baseline into the engine's generic ApprovedCommercialBaseline.
// NO engineering recalculation happens here — every figure is read from the frozen baseline.

/** Which stage a baseline line's scope belongs to (visibility only — allocations never drive billing). */
const STAGE_BY_ITEM: Record<string, string> = { delivery: "Delivery", installation: "Installation", concrete_slat_delivery: "Delivery" };

/** Splits the contract across the six confirmed stages; the last stage absorbs any rounding so the schedule balances exactly. */
export function splitContractIntoStages(contractCents: number): SuggestedStage[] {
  let allocated = 0;
  return POC_STAGE_SPLIT_BPS.map((s, i) => {
    const isLast = i === POC_STAGE_SPLIT_BPS.length - 1;
    const valueCents = isLast ? contractCents - allocated : Math.floor((contractCents * s.bps) / 10_000);
    allocated += valueCents;
    return { name: s.name, description: s.description, valueCents };
  });
}

export function quoteToProjectBaseline(b: AcceptedBaseline, baselineHash: string, quoteId: string): ApprovedCommercialBaseline {
  const lines: BaselineLine[] = [
    ...b.commercial.lines.map((l) => ({
      lineRef: l.itemKey, sku: l.sku, description: l.label, quantity: l.quantity, salesValueCents: l.revenueCents,
      estimatedCostCents: null, suggestedStageName: STAGE_BY_ITEM[l.itemKey] ?? "Manufacturing",
    })),
    ...b.commercial.charges.map((c) => ({
      lineRef: c.key, sku: null, description: c.label, quantity: 1, salesValueCents: c.amountCents,
      estimatedCostCents: null, suggestedStageName: STAGE_BY_ITEM[c.key] ?? "Manufacturing",
    })),
  ];
  return {
    sourceQuoteRef: b.quote.ref,
    sourceQuoteId: null, // projects.originating_quote_id is an FK to the Toolbox `quotes` table; the NewQuip quote id is carried in provenance
    customer: { cin7CustomerId: null, name: b.quote.customerName },
    currency: "ZAR",
    contractCents: b.contractCents,
    taxRule: b.commercial.taxRule,
    taxRateBps: b.commercial.taxRateBps,
    taxInclusive: b.commercial.taxInclusive,
    salesperson: b.approvals.handoffBy,
    lines,
    suggestedStages: splitContractIntoStages(b.contractCents),
    // Inherited, never re-entered: the sealed scope, or - for a baseline sealed before it existed - the identical rebuild from its sealed lines.
    physicalScope: structuredClone(b.physicalScope ?? buildPhysicalScope(b.commercial.lines)),
    provenance: {
      kind: "newquip_grower_quote",
      newquipQuoteId: quoteId,
      quoteRef: b.quote.ref,
      quoteRevision: b.quote.revision,
      baselineHash,
      site: b.quote.siteName,
      template: b.template,
      priceSource: b.pricing.source.label,
      approvedBy: b.approvals.managerApprovedBy,
      approvedAt: b.approvals.managerApprovedAt,
    },
  };
}
