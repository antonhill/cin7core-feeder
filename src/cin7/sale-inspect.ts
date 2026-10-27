import { cin7Request } from "@/cin7/http";
import type { Cin7Credentials } from "@/cin7/types";
import type { Cin7ProductAvailabilityEntry } from "@/cin7/product-availability";

// READ-ONLY (GET only) helpers for the T0 proof inspector (docs/projects-poc/architecture-inventory-billing-costing.md section 19).
// Nothing here can write to Cin7: no method other than the gateway's default GET is ever passed. The caller projects the raw payload
// down to an allow-list of fields before anything is shown (src/lib/cin7-proof/t0.ts); the raw payload never leaves the server.

/** One `GET /sale?ID=`. Returned untyped on purpose: the projection decides what may be shown. */
export async function fetchSaleForInspection(creds: Cin7Credentials, saleId: string): Promise<unknown> {
  return cin7Request<unknown>(creds, "/sale", { query: { ID: saleId } });
}

/**
 * Live availability rows for ONE SKU. Tries the documented `Sku` filter first (UNVERIFIED live); if it yields no exact-SKU row (filter
 * ignored or SKU absent) it falls back to a bounded page scan, so the answer is correct either way. GET only.
 */
export async function fetchAvailabilityForSku(creds: Cin7Credentials, sku: string): Promise<Cin7ProductAvailabilityEntry[]> {
  const exact = (rows: Cin7ProductAvailabilityEntry[]) => rows.filter((r) => r.SKU === sku);
  const first = await cin7Request<{ ProductAvailabilityList?: Cin7ProductAvailabilityEntry[] }>(creds, "/ref/productavailability", { query: { Page: 1, Limit: 1000, Sku: sku } });
  const hit = exact(first.ProductAvailabilityList ?? []);
  if (hit.length > 0) return hit;
  const found: Cin7ProductAvailabilityEntry[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await cin7Request<{ ProductAvailabilityList?: Cin7ProductAvailabilityEntry[] }>(creds, "/ref/productavailability", { query: { Page: page, Limit: 1000 } });
    const rows = res.ProductAvailabilityList ?? [];
    found.push(...exact(rows));
    if (rows.length < 1000) break;
  }
  return found;
}
