import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed live (2026-07-06): `/production/orderList` (capital-case
 * `Page`/`Limit`) — a genuinely different, working path family from the
 * `/production/workcenters` wall documented for Work Centre/Resource lookups
 * (see probeWorkCentrePaths in debug.ts) — Production Orders are NOT blocked
 * the same way. List key is `ProductionOrderListItems`, inconsistent with
 * every other list endpoint's naming in this codebase (worth remembering,
 * not a typo). Every other path variant tried
 * (`/productionOrder`, `/ProductionOrderList`, etc.) 404s as branded HTML.
 *
 * Each Manufacture Order (`Type: "O"`) can have one or more associated
 * Routing sub-rows (`Type: "R"`) sharing the same `ProductionOrderID` but a
 * distinct `TaskID` — callers MUST filter to `Type === "O"` or they'll
 * double-count. `RequiredByDate` is the confirmed due-date field.
 */
export interface Cin7ProductionOrderListEntry {
  TaskID: string;
  ProductionOrderID?: string;
  Type?: string;
  OrderNumber?: string;
  ProductSku?: string;
  ProductName?: string;
  LocationName?: string;
  Status?: string;
  OrderStatus?: string;
  RequiredByDate?: string | null;
  CompletionDate?: string | null;
  /** Free-text, commonly used to note which customer/sales order a run is for — confirmed live 2026-07-14, MO-00042: "Anton Hill Order: 23424324". */
  Tags?: string;
}

/** Fetches every production order (and routing sub-)record on the account. Paginates until a short page signals the end, same pattern as fetchAllSalesList. */
export async function fetchAllProductionOrdersList(creds: Cin7Credentials): Promise<Cin7ProductionOrderListEntry[]> {
  const pageSize = 100;
  const all: Cin7ProductionOrderListEntry[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ ProductionOrderListItems?: Cin7ProductionOrderListEntry[] }>(creds, "/production/orderList", {
      query: { Page: page, Limit: pageSize },
    });
    const orders = response.ProductionOrderListItems ?? [];
    all.push(...orders);
    if (orders.length < pageSize) break;
  }
  return all;
}
