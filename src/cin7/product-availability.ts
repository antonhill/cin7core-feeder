import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed live 2026-07-09 (surveyProductAvailabilityFields, src/cin7/debug.ts):
 * list key is `ProductAvailabilityList`; `StockValue`/`Category` don't
 * exist; `OnHand` is the real per-row quantity (Available = OnHand -
 * Allocated holds exactly); `StockOnHand` is actually a value field
 * (constant ratio to OnHand per SKU) — see 0030_product_availability.sql
 * for the full write-up.
 */
export interface Cin7ProductAvailabilityEntry {
  ID: string;
  SKU: string;
  Name?: string;
  Location?: string;
  Bin?: string | null;
  Batch?: string | null;
  ExpiryDate?: string | null;
  OnHand?: number;
  Available?: number;
  OnOrder?: number;
  InTransit?: number;
  Allocated?: number;
  StockOnHand?: number;
  NextDeliveryDate?: string | null;
}

/**
 * Fetches the full live stock snapshot across every location/bin/batch.
 * Deliberately does NOT filter to non-zero quantities (unlike the Cin7 UI's
 * own default) — a real stockout must stay visible for the Stock Health
 * report, not be silently excluded. Paginates until a short page signals
 * the end, same convention as every other list-scan fetch in this codebase.
 */
export async function fetchAllProductAvailability(creds: Cin7Credentials): Promise<Cin7ProductAvailabilityEntry[]> {
  const pageSize = 200;
  const all: Cin7ProductAvailabilityEntry[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ ProductAvailabilityList?: Cin7ProductAvailabilityEntry[] }>(creds, "/ref/productavailability", {
      query: { Page: page, Limit: pageSize },
    });
    const entries = response.ProductAvailabilityList ?? [];
    all.push(...entries);
    if (entries.length < pageSize) break;
  }
  return all;
}
