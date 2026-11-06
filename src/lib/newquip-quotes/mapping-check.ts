import "server-only";
// Server-side catalogue verification of a draft's confirmed product mappings. One implementation, used when a draft is stored and again at estimator sign-off.
// Read-only: it queries this organisation's synced Cin7 product catalogue and never calls Cin7.
import type { createServiceRoleClient } from "@/supabase/server";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { mappingError } from "@/newquip/grower/mapping-integrity";

type Db = ReturnType<typeof createServiceRoleClient>;

/** Throws when any of `mapped` is unknown, not the source-backed SKU, absent from this org's catalogue, or inactive. Fails closed if the catalogue cannot be read. */
export async function verifyMappings(db: Db, orgId: string, mapped: ReadonlyArray<{ itemKey: string; sku: string }>, feederVariant: QuoteDraft["config"]["feederVariant"]): Promise<void> {
  if (!mapped.length) return;
  const rows = await db.from("products").select("sku, active").eq("org_id", orgId).in("sku", [...new Set(mapped.map((m) => m.sku))]);
  if (rows.error) throw new Error(`The mapped products could not be verified against the Cin7 catalogue (${rows.error.message}). Nothing was saved.`);
  const err = mappingError(mapped, (rows.data ?? []) as Array<{ sku: string; active: boolean | null }>, feederVariant);
  if (err) throw new Error(err);
}
