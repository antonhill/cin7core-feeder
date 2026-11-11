import { matchesSearch } from "@/app/reports/text-search";
import { qualityGroup, LINE_STATUS_LABEL, type PoQuantityRow } from "@/reports/po-quantity-comparison";

export type PoSortColumn = "po" | "supplier" | "orderDate" | "poStatus" | "sku" | "ordered" | "received" | "outstanding" | "lineStatus";
export type PoSortDirection = "asc" | "desc";

/**
 * Everything the on-screen table does to the loaded rows: filters + sort. Shared
 * by the page and the Excel export so the export can be rebuilt on the server
 * from this small spec instead of the browser posting thousands of rows back
 * (a 7,170-row POST exceeded the platform's request-body limit and crashed the page).
 */
export interface PoViewSpec {
  supplier: string;
  poStatus: string;
  lineStatus: string;
  /** A QualityGroup ("complete" | "incomplete" | "stale" | "review" | "not_applicable") or "" for all. */
  quality: string;
  poSearch: string;
  search: string;
  sortColumn: PoSortColumn;
  sortDirection: PoSortDirection;
}

/** Nulls sort last regardless of direction (same rule as the report tables' shared comparator). */
export function compareNullable(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const an = a ?? null;
  const bn = b ?? null;
  if (an === null && bn === null) return 0;
  if (an === null) return 1;
  if (bn === null) return -1;
  if (typeof an === "number" && typeof bn === "number") return an - bn;
  return String(an).localeCompare(String(bn));
}

export function poSortValue(r: PoQuantityRow, c: PoSortColumn): string | number | null {
  switch (c) {
    case "po":
      return r.orderNumber;
    case "supplier":
      return r.supplierName;
    case "orderDate":
      return r.orderDate;
    case "poStatus":
      return r.poStatus;
    case "sku":
      return r.sku;
    case "lineStatus":
      return r.lineStatus ? LINE_STATUS_LABEL[r.lineStatus] : null;
    default:
      return r[c];
  }
}

export function filterPoRows(rows: PoQuantityRow[], spec: PoViewSpec): PoQuantityRow[] {
  return rows.filter((r) => {
    if (spec.supplier && r.supplierName !== spec.supplier) return false;
    if (spec.poStatus && r.poStatus !== spec.poStatus) return false;
    if (spec.lineStatus && r.lineStatus !== spec.lineStatus) return false;
    if (spec.quality && qualityGroup(r.dataQuality) !== spec.quality) return false;
    if (!matchesSearch(spec.poSearch, r.orderNumber)) return false;
    return matchesSearch(spec.search, r.sku, r.productName);
  });
}

export function sortPoRows(rows: PoQuantityRow[], column: PoSortColumn, direction: PoSortDirection): PoQuantityRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = poSortValue(a, column);
    const bv = poSortValue(b, column);
    // Blank values (incomplete POs) stay last in BOTH directions — negating the comparator would float them to the top when descending.
    if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
    if (bv === null || bv === undefined) return -1;
    const cmp = compareNullable(av, bv);
    return direction === "asc" ? cmp : -cmp;
  });
  return copy;
}

export function applyPoView(rows: PoQuantityRow[], spec: PoViewSpec): PoQuantityRow[] {
  return sortPoRows(filterPoRows(rows, spec), spec.sortColumn, spec.sortDirection);
}
