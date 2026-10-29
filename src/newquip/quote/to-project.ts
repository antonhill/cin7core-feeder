import type { ApprovedCommercialBaseline, BaselineLine, SuggestedStage } from "@/lib/projects/baseline";
import type { AcceptedBaseline } from "./baseline";
import { buildPhysicalScope } from "./physical-scope";
import { splitContractBySchedule, type ScheduleStageTemplate } from "./billing-schedule";
import type { ScheduleSource } from "./project-template";

// NewQuip Quote-to-Project ADAPTER. The NewQuip domain may know about its scope and stages; the generic Projects engine must
// not. This is the only place the two meet: it turns an ACCEPTED baseline into the engine's generic ApprovedCommercialBaseline.
// NO engineering recalculation happens here — every figure is read from the frozen baseline.

/** Which stage a baseline line's scope belongs to (visibility only — allocations never drive billing). */
const STAGE_BY_ITEM: Record<string, string> = { delivery: "Delivery", installation: "Installation", concrete_slat_delivery: "Delivery" };

/** New NewQuip projects default to the confirmed 40/55/5 standard schedule (see billing-schedule.ts); a schedule may be supplied. */
export function splitContractIntoStages(contractCents: number, schedule?: readonly ScheduleStageTemplate[]): SuggestedStage[] {
  return splitContractBySchedule(contractCents, schedule);
}

export function quoteToProjectBaseline(b: AcceptedBaseline, baselineHash: string, quoteId: string, schedule?: readonly ScheduleStageTemplate[], scheduleSource?: ScheduleSource): ApprovedCommercialBaseline {
  const lines: BaselineLine[] = [
    ...b.commercial.lines.map((l) => ({
      lineRef: l.itemKey, sku: l.sku, description: l.label, quantity: l.quantity, salesValueCents: l.revenueCents,
      estimatedCostCents: null, suggestedStageName: STAGE_BY_ITEM[l.itemKey] ?? "Delivery",
    })),
    ...b.commercial.charges.map((c) => ({
      lineRef: c.key, sku: null, description: c.label, quantity: 1, salesValueCents: c.amountCents,
      estimatedCostCents: null, suggestedStageName: STAGE_BY_ITEM[c.key] ?? "Delivery",
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
    suggestedStages: splitContractIntoStages(b.contractCents, schedule),
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
      // Where the stages came from (a template version is recorded by id + version; the stages themselves are the project's own frozen copy).
      ...(scheduleSource ? { billingSchedule: scheduleSource } : {}),
    },
  };
}
