import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed live (2026-07-06): the resource representing an actual assembly
 * build/job (distinct from an Assembly BOM *definition*, which lives on
 * /Product — see assembly-bom.ts) is `/finishedGoodsList` (capital-case
 * `Page`/`Limit`), list key `FinishedGoods`. Every other candidate path
 * (`/assembly`, `/AssemblyList`, `/production/assembly`, etc.) returns Cin7's
 * branded "Page not found" HTML with HTTP 200 — not a real endpoint. Real
 * `Status` value set is DRAFT/AUTHORISED/IN PROGRESS/COMPLETED/VOIDED. No
 * deadline/due-date field exists anywhere on this resource, even at detail
 * level (`ExpiryDate` is a batch/perishable-tracking field, always null on
 * every record checked; `Date`/`WIPDate`/`CompletionDate` are all
 * progress timestamps, not target dates) — confirmed, not a gap in this
 * client.
 */
export interface Cin7FinishedGoodsListEntry {
  TaskID: string;
  AssemblyNumber?: string;
  ProductCode?: string;
  ProductName?: string;
  Status?: string;
  Date?: string | null;
}

/** Fetches every finished-goods assembly record on the account. Paginates until a short page signals the end, same pattern as fetchAllSalesList. */
export async function fetchAllFinishedGoodsList(creds: Cin7Credentials): Promise<Cin7FinishedGoodsListEntry[]> {
  const pageSize = 100;
  const all: Cin7FinishedGoodsListEntry[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ FinishedGoods?: Cin7FinishedGoodsListEntry[] }>(creds, "/finishedGoodsList", {
      query: { Page: page, Limit: pageSize },
    });
    const goods = response.FinishedGoods ?? [];
    all.push(...goods);
    if (goods.length < pageSize) break;
  }
  return all;
}
