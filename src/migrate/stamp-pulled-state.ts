import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/supabase/fetch-all-rows";
import type { RunImportResult } from "@/import/run-import";

// A Migrate PULL is read-only against Cin7: it copies the source instance's master data into the organization's canonical tables. But canonical rows carry
// a database-maintained content_hash, and the push compares it with the hash each instance last received (sync_state / customer_sync_state /
// supplier_sync_state). A pull changes content_hash and records nothing there, so every pulled row looked "changed" and was written straight back to the
// instance it had just been read from (observed: tens of thousands of acknowledged PUTs minutes after a pull).
//
// After a pull commits cleanly, record each pulled row as in sync with its SOURCE instance - which is exactly what it is. Only the source: pushing that data
// to a DIFFERENT instance is Migrate's purpose and stays a deliberate push, whose hash comparison still sees those rows as new for that instance.
// Rows are marked only when the whole import committed with no invalid rows, so a row that failed validation (and kept its old canonical content) is never
// mislabelled as matching Cin7. cin7_id is not written: an existing one is kept for the push's find-by-id fast path.

type Group = "products" | "customers" | "suppliers";
const TARGET: Record<Group, { canonical: string; state: string; key: string; kind: "products" | "customers" | "suppliers" }> = {
  products: { canonical: "products", state: "sync_state", key: "sku", kind: "products" },
  customers: { canonical: "customers", state: "customer_sync_state", key: "name", kind: "customers" },
  suppliers: { canonical: "suppliers", state: "supplier_sync_state", key: "name", kind: "suppliers" },
};
const UPSERT_CHUNK = 500;

export const PULLED_STATUS = "pulled";

/** Marks `pulledKeys` (SKUs or Names the source instance returned) as already synced to `sourceInstanceId`. Returns how many state rows were written. */
export async function stampPulledState(
  db: SupabaseClient,
  orgId: string,
  sourceInstanceId: string,
  group: Group,
  pulledKeys: readonly string[],
  importResult: Pick<RunImportResult, "committed" | "errorCount"> | undefined
): Promise<number> {
  if (!importResult || !importResult.committed || importResult.errorCount > 0 || pulledKeys.length === 0) return 0;
  const t = TARGET[group];
  const wanted = new Set(pulledKeys);

  const columns: string = `${t.key}, content_hash`; // typed as plain string: the table and key vary by group
  const canonical = await fetchAllRows<Record<string, string | null>>(`${t.canonical} hashes`, (from, to) =>
    db.from(t.canonical).select(columns).eq("org_id", orgId).order(t.key).range(from, to) as unknown as PromiseLike<{ data: Record<string, string | null>[] | null; error: { message: string } | null }>
  );
  const now = new Date().toISOString();
  const rows = canonical
    .filter((r) => r[t.key] && wanted.has(r[t.key] as string))
    .map((r) => ({
      org_id: orgId,
      instance_id: sourceInstanceId,
      [t.key]: r[t.key],
      synced_hash: r.content_hash,
      last_synced_at: now,
      last_status: PULLED_STATUS,
      last_error: null,
      // products only: a pulled row has no failure history that still matters
      ...(group === "products" ? { failure_class: null, failure_fingerprint: null, consecutive_failures: 0, next_retry_at: null } : {}),
    }));

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await db.from(t.state).upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: `org_id,instance_id,${t.key}` });
    if (error) throw new Error(`Recording the pulled ${group} as already in sync failed: ${error.message}`);
  }
  return rows.length;
}
