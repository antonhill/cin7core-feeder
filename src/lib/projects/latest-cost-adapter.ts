import "server-only";
// The ONE place the NewQuip cost estimate touches the Cin7 API: a READ-ONLY lookup of each SKU's supplier costs. Credentials are loaded for the org's own
// instance, never leave the server and are never logged. (The Grower module itself stays sealed from Cin7; it asks this adapter.)
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchProductCostRead } from "@/cin7/latest-cost";
import { resolveLatestCost, type CostEntry } from "./latest-cost";

type Db = ReturnType<typeof createServiceRoleClient>;

/** Latest cost entries for the given SKUs (one entry per SKU; a SKU without a usable latest cost has a null unit cost - MISSING - never zero). */
export async function readLatestCostEntries(db: Db, orgId: string, instanceId: string, skus: readonly string[], nowIso: string): Promise<Record<string, CostEntry>> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const out: Record<string, CostEntry> = {};
  for (const sku of [...new Set(skus)]) {
    const read = await fetchProductCostRead(creds, sku);
    const latest = read ? resolveLatestCost(read.suppliers) : null;
    out[sku] = latest && latest.status === "LATEST"
      ? { unitCostCents: latest.unitCostCents, source: "CIN7_LATEST", retrievedAt: nowIso, supplier: latest.supplier, lastSupplied: latest.lastSupplied }
      : { unitCostCents: null, source: "CIN7_LATEST", retrievedAt: nowIso };
  }
  return out;
}
