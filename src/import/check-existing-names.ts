import type { SupabaseClient } from "@supabase/supabase-js";

/** Returns the subset of `names` that have no matching row in customers for this org. */
export async function findMissingCustomerNames(
  db: SupabaseClient,
  orgId: string,
  names: string[]
): Promise<Set<string>> {
  const unique = [...new Set(names)];
  if (!unique.length) return new Set();

  const { data, error } = await db.from("customers").select("name").eq("org_id", orgId).in("name", unique);
  if (error) throw new Error(`customers lookup: ${error.message}`);

  const existing = new Set((data ?? []).map((r: { name: string }) => r.name));
  return new Set(unique.filter((name) => !existing.has(name)));
}

/** Returns the subset of `names` that have no matching row in suppliers for this org. */
export async function findMissingSupplierNames(
  db: SupabaseClient,
  orgId: string,
  names: string[]
): Promise<Set<string>> {
  const unique = [...new Set(names)];
  if (!unique.length) return new Set();

  const { data, error } = await db.from("suppliers").select("name").eq("org_id", orgId).in("name", unique);
  if (error) throw new Error(`suppliers lookup: ${error.message}`);

  const existing = new Set((data ?? []).map((r: { name: string }) => r.name));
  return new Set(unique.filter((name) => !existing.has(name)));
}
