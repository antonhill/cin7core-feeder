import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import type { DemoState } from "@/rwtsa-demo/state/demo-state";

/**
 * Commercial rules a LOCAL workbook does not establish. Each is named, says what it withholds, and says how it is resolved:
 *   - "choose": a control on the page, set explicitly by the viewer (never defaulted for a local workbook),
 *   - "owner":  an owner decision that cannot be made on the page; the affected output stays withheld.
 * The synthetic source declares its own conventions, so it has no open rules.
 */

export type RuleId = "tender-classification" | "overdue-on-water" | "sales-history-gap" | "overhead-efficiency-margin" | "payment-status";

export interface UnresolvedRule {
  readonly id: RuleId;
  readonly title: string;
  readonly detail: string;
  readonly withholds: string;
  readonly how: "choose" | "owner";
}

/** Rules are only open for a local workbook. */
export function rulesApply(state: DemoState): boolean {
  return state.kind === "validated" && state.provenance === "LOCAL WORKBOOK" && state.dataset !== null;
}

export const tenderRule = (): UnresolvedRule => ({
  id: "tender-classification",
  title: "Tender SKU classification",
  detail: "Not every SKU carries a tender marker (Items.isTender is absent or incomplete), so the tender replenishment exemption cannot be applied reliably and no unmarked SKU can be confirmed as orderable.",
  withholds: "Proposed order quantities",
  how: "owner",
});

export const overdueRule = (units: number): UnresolvedRule => ({
  id: "overdue-on-water",
  title: "Overdue shipments on the water",
  detail: `${units} unit(s) on purchase-order lines still marked on the water have an ETA to stores before the stock date. The workbook does not say whether they have arrived, are late or are misdated. Choose a treatment in the controls.`,
  withholds: "All Scenario A results (projection, first breach, shortfall, proposed orders) until a treatment is chosen",
  how: "choose",
});

export const historyGapRule = (lastMonth: string | null, gap: readonly string[]): UnresolvedRule => ({
  id: "sales-history-gap",
  title: "Sales history ends before the stock month",
  detail: `History ends in ${lastMonth ?? "an unknown month"}; ${gap.length} month(s) before the stock date have no data. Whether to forecast from the last months on file or to require months up to the stock date is a business rule. Choose in the controls.`,
  withholds: "All Scenario A results until a treatment is chosen",
  how: "choose",
});

/** True when any routing line lacks the overhead or efficiency value the cost model needs. */
export function overheadUnresolved(ds: RwtsaDataset): boolean {
  return ds.tables.routing.length > 0 && ds.tables.routing.some((r) => r.overhead === null || r.efficiency === null);
}
export const overheadRule = (): UnresolvedRule => ({
  id: "overhead-efficiency-margin",
  title: "Overhead, efficiency allowance and margin",
  detail: "Routing_SMV carries no overhead, efficiency or margin values the cost model can use. Whether these enter product cost, and how, is not established by the workbook. Any amounts stated elsewhere on the sheet are not used.",
  withholds: "Product cost totals and selling prices are withheld",
  how: "owner",
});

export const paymentRule = (): UnresolvedRule => ({
  id: "payment-status",
  title: "Paid or open USD exposure",
  detail: "The workbook has no paid-status column, so which payments are still open is not known. Choose to treat payments due on or after the as-at date as open, or leave the exposure withheld.",
  withholds: "Open, covered and uncovered USD exposure",
  how: "choose",
});
