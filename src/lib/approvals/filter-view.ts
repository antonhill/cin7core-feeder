// Presentation helpers for the Approvals queue filter bar. Pure: they never decide WHICH rows match (filterQueue / the server does), only how the
// current filter state is summarised and which filters sit behind "More filters".
import { activeFilters, CLEARED_FILTERS, type ActiveFilter, type QueueFilters, type QueueSort } from "./queue";
import type { ApprovalStatus } from "./types";

/** What the page loads with. NOT what "Clear filters" returns to: Clear goes to CLEARED_FILTERS (Status Any), the UAT-018 behaviour. */
export const DEFAULT_QUEUE_FILTERS: QueueFilters = { status: "PENDING" };
export const DEFAULT_QUEUE_SORT: QueueSort = "submitted_asc";
export const SORT_LABEL: Record<QueueSort, string> = {
  submitted_asc: "Oldest submission first", submitted_desc: "Newest submission first", waiting_desc: "Longest waiting", amount_desc: "Amount, high to low", amount_asc: "Amount, low to high",
};
/** The filters that live behind "More filters" (the always-visible ones are Show and Status; Sort is not a filter). */
export const SECONDARY_KEYS: ReadonlyArray<keyof QueueFilters> = ["docType", "customer", "project", "preparer", "assignee", "from", "to", "overdueOnly"];

export const secondaryActive = (f: QueueFilters): ActiveFilter[] => activeFilters(f).filter((a) => SECONDARY_KEYS.includes(a.key));

/** Everything that differs from the default view, as text. "Status: Any" is listed because it differs from the default even though it does not narrow. */
export function summaryItems(f: QueueFilters, sort: QueueSort, statusLabel: (s: ApprovalStatus) => string): string[] {
  const items = activeFilters(f, statusLabel).map((a) => a.label);
  if (f.status === "ANY" || f.status === undefined) items.unshift("Status: Any");
  if (sort !== DEFAULT_QUEUE_SORT) items.push(`Sorted: ${SORT_LABEL[sort]}`);
  return items;
}

/** True when the filters and sort are exactly the page defaults (so there is nothing to clear). */
export function isDefaultView(f: QueueFilters, sort: QueueSort): boolean {
  const a = activeFilters(f);
  return sort === DEFAULT_QUEUE_SORT && f.status === "PENDING" && a.length === 1 && a[0].key === "status";
}

/** UAT-018: Clear filters is offered whenever any filter narrows the list, including the default Pending status (that is what hides history). */
export const hasActiveFilters = (f: QueueFilters): boolean => activeFilters(f).length > 0;
export { CLEARED_FILTERS };
