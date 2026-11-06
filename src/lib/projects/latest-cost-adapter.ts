import "server-only";
// The ONE place the NewQuip cost estimate touches the Cin7 API: a READ-ONLY lookup of each SKU's supplier price records. Credentials are loaded for the org's own
// instance, never leave the server and are never logged. (The Grower module itself stays sealed from Cin7; it asks this adapter.)
//
// Each Suppliers[] record becomes a RawSupplierPrice. Interpreted fields: SupplierName / SupplierID|ID, Cost (the supplier's Latest Price), LastSupplied, and
// Currency when the record carries one. When it does not, the price currency is the SUPPLIER'S currency from the Toolbox's synced supplier master (Cin7 shows
// supplier prices in supplier currency); an unknown supplier currency stays unknown and the price is unusable. FixedCost and AverageCost are never read here.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchProductCostRead } from "@/cin7/latest-cost";
import { rawFromCin7, type RawSupplierPrice } from "./supplier-price";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface SkuSupplierPrices { sku: string; found: boolean; stockUom: string | null; raws: RawSupplierPrice[] }

async function supplierCurrencies(db: Db, orgId: string, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (names.length === 0) return out;
  const r = await db.from("suppliers").select("name, currency").eq("org_id", orgId).in("name", names);
  if (r.error) return out; // unknown stays unknown: the affected prices are unusable, never assumed rand
  for (const row of (r.data ?? []) as Array<{ name: string; currency: string | null }>) if (row.currency) out.set(row.name, row.currency);
  return out;
}

/** Every supplier price record of each SKU (one read per SKU). A SKU Cin7 does not return exactly is `found: false`. */
export async function readSupplierPrices(db: Db, orgId: string, instanceId: string, skus: readonly string[]): Promise<Record<string, SkuSupplierPrices>> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const reads = new Map<string, Awaited<ReturnType<typeof fetchProductCostRead>>>();
  for (const sku of [...new Set(skus)]) reads.set(sku, await fetchProductCostRead(creds, sku));
  const names = [...new Set([...reads.values()].flatMap((p) => (p?.rawSuppliers ?? []).map((s) => (typeof s.SupplierName === "string" ? s.SupplierName : typeof s.Supplier === "string" ? s.Supplier : null))).filter((n): n is string => !!n))];
  const cur = await supplierCurrencies(db, orgId, names);
  const out: Record<string, SkuSupplierPrices> = {};
  for (const [sku, p] of reads) {
    out[sku] = p
      ? { sku, found: true, stockUom: p.uom, raws: p.rawSuppliers.map((s) => ({ ...rawFromCin7(s, (n) => (n ? cur.get(n) ?? null : null)), stockUnit: p.uom })) }
      : { sku, found: false, stockUom: null, raws: [] };
  }
  return out;
}
