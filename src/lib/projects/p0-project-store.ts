import "server-only";
// Disposable P0 project: catalogue search (LOCAL cache, no Cin7 call) and creation (Toolbox rows only). Creating the project writes nothing to
// Cin7. The chosen SKUs and quantities are re-verified LIVE (read-only) against the connected Cin7 instance before anything is stored.
import type { createServiceRoleClient } from "@/supabase/server";
import { createProjectFromBaseline } from "./project-store";
import { buildP0Baseline, P0_DISPOSABLE_PREFIX, type P0ProjectInput } from "./p0-project";
import type { P0Port } from "./p0-checklist";
import { fetchAllRows } from "@/supabase/fetch-all-rows";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }

export interface StockedProduct { sku: string; name: string; available: number; onHand: number; syncedAt: string }

/** Why a search found nothing (or what it found), so the owner is never told "no stock" when the truth is "not found" or "could not look". */
export type ProductSearchOutcome =
  | "FOUND"                  // at least one product with free stock at the location
  | "ANY_STOCK_AT_LOCATION"  // (no text entered) nothing in stock at the location
  | "NOT_IN_CATALOGUE"       // no synced product matches the text at any location
  | "NO_STOCK_AT_LOCATION"   // matches exist at the location but none has free stock
  | "OTHER_LOCATIONS_ONLY";  // matches exist, but only at other locations
export interface ProductSearchResult { products: StockedProduct[]; outcome: ProductSearchOutcome; detail: string; otherLocations: Array<{ location: string; available: number }> }

type CacheRow = { product_sku: string; product_name: string | null; location: string; on_hand: number | string | null; available: number | string | null; synced_at: string };

/** Characters that would change meaning inside a PostgREST `or()` filter or an ILIKE pattern are removed/escaped: the text is only ever a substring. */
function likeTerm(q: string): string {
  return q.replace(/[,()*"]/g, " ").trim().replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Existing Cin7 products with free stock at `location`, from the synced local cache (org-scoped, no Cin7 call). Matches the text against SKU
 * and description (case-insensitive, partial or exact). The cache is large (a location can hold >10,000 rows) and Supabase silently returns only
 * the first 1,000 rows of an unpaged read, so the text filter runs in the database and every page is read (fetchAllRows). A lookup failure THROWS;
 * it is never reported as "no products".
 */
export async function searchProductStock(db: Db, orgId: string, location: string, query: string, limit = 25): Promise<ProductSearchResult> {
  const loc = location.trim();
  if (!loc) fail("Enter the Cin7 location (for example MSTR).");
  const q = query.trim();
  const term = likeTerm(q);
  const rows = await fetchAllRows<CacheRow>("search products", (from, to) => {
    let qy = db.from("product_availability").select("product_sku, product_name, location, on_hand, available, synced_at").eq("org_id", orgId);
    // With text: every location (so a product held elsewhere can be explained). Without: only this location.
    qy = term ? qy.or(`product_sku.ilike.*${term}*,product_name.ilike.*${term}*`) : qy.eq("location", loc);
    return qy.order("product_sku").order("location").order("id").range(from, to);
  });

  const lower = q.toLowerCase();
  const bySku = new Map<string, StockedProduct>();
  const matched = new Set<string>(); const elsewhere = new Map<string, number>();
  for (const x of rows) {
    if (!x.product_sku) continue;
    if (term && !(x.product_sku.toLowerCase().includes(lower) || (x.product_name ?? "").toLowerCase().includes(lower))) continue; // belt and braces
    matched.add(x.product_sku);
    const available = Number(x.available);
    if (x.location !== loc) { if (Number.isFinite(available) && available > 0) elsewhere.set(x.location, (elsewhere.get(x.location) ?? 0) + available); continue; }
    if (!Number.isFinite(available) || available <= 0) continue; // unknown or zero stock is never offered
    const prev = bySku.get(x.product_sku);
    bySku.set(x.product_sku, { sku: x.product_sku, name: x.product_name ?? "", available: (prev?.available ?? 0) + available, onHand: (prev?.onHand ?? 0) + (Number(x.on_hand) || 0), syncedAt: x.synced_at });
  }
  const rank = (p: StockedProduct) => (p.sku.toLowerCase() === lower ? 0 : p.sku.toLowerCase().startsWith(lower) ? 1 : 2); // exact SKU first, then prefix
  const products = [...bySku.values()].sort((a, b) => rank(a) - rank(b) || b.available - a.available || (a.sku < b.sku ? -1 : 1)).slice(0, limit);
  const otherLocations = [...elsewhere].map(([location, available]) => ({ location, available })).sort((a, b) => b.available - a.available);

  if (products.length) return { products, outcome: "FOUND", detail: `${products.length} product${products.length === 1 ? "" : "s"} with free stock at "${loc}".`, otherLocations };
  if (!term) return { products, outcome: "ANY_STOCK_AT_LOCATION", detail: `No product has free stock at "${loc}" in the synced cache.`, otherLocations };
  if (matched.size === 0) return { products, outcome: "NOT_IN_CATALOGUE", detail: `No synced product has a SKU or description containing "${q}". Check the spelling, or re-run the Cin7 stock sync if the product is new.`, otherLocations };
  if (otherLocations.length) return { products, outcome: "OTHER_LOCATIONS_ONLY", detail: `"${q}" exists, but has no free stock at "${loc}" (free elsewhere: ${otherLocations.map((o) => `${o.location} ${o.available}`).join(", ")}).`, otherLocations };
  return { products, outcome: "NO_STOCK_AT_LOCATION", detail: `"${q}" exists in the catalogue but has no free stock at "${loc}".`, otherLocations };
}

/** Compatibility wrapper: just the products. */
export async function searchStockedProducts(db: Db, orgId: string, location: string, query: string, limit = 25): Promise<StockedProduct[]> {
  return (await searchProductStock(db, orgId, location, query, limit)).products;
}

export interface CreateP0Input extends P0ProjectInput { location: string }

/**
 * Creates the disposable P0 project. Manager only. Re-verifies, read-only and live, that every chosen SKU exists in Cin7 by exact match and has
 * enough free stock at the location; refuses (storing nothing) if not. The reference is `P0-<yyyymmdd>-<n>`; the (org, reference) unique
 * constraint means a double click cannot create two projects with the same reference.
 */
export async function createP0Project(
  db: Db, port: Pick<P0Port, "resolveProducts" | "stockAt">, gates: { isManager: boolean }, email: string, denylist: readonly string[],
  input: CreateP0Input & { orgId: string; now?: Date },
): Promise<{ projectId: string; reference: string }> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can prepare a P0 project.");
  const loc = input.location.trim();
  if (!loc) fail("Enter the Cin7 location (for example MSTR).");
  const day = (input.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, "");
  const existing = await db.from("projects").select("project_reference").eq("org_id", input.orgId);
  if (existing.error) fail(existing.error.message);
  const n = ((existing.data ?? []) as Array<{ project_reference: string }>).filter((p) => p.project_reference.startsWith(`P0-${day}-`)).length + 1;
  const reference = `P0-${day}-${n}`;
  const plan = buildP0Baseline(reference, input, denylist);
  if (!plan.ok) fail(plan.error);

  const skus = input.products.map((p) => p.sku);
  const res = await port.resolveProducts(skus);
  if (res.missing.length) fail(`These SKUs do not exist in Cin7: ${res.missing.join(", ")}. Nothing was created.`);
  for (const p of input.products) {
    const rows = (await port.stockAt(p.sku)).filter((r) => r.location === loc);
    const avail = rows.length === 0 ? null : rows.reduce<number | null>((a, r) => (a === null || r.available === null ? null : a + r.available), 0);
    if (rows.length === 0) fail(`${p.sku} has no stock row at "${loc}" in Cin7. Nothing was created.`);
    if (avail === null) fail(`The free stock of ${p.sku} at "${loc}" is unreadable. Nothing was created.`);
    if (avail < p.quantity) fail(`${p.sku}: ${avail} available at "${loc}" in Cin7, ${p.quantity} needed. Nothing was created.`);
  }
  const projectId = await createProjectFromBaseline(db, input.orgId, email, plan.baseline, { reference, name: `P0 DISPOSABLE ${reference} - ${plan.baseline.customer.name}` });
  return { projectId, reference };
}

export { P0_DISPOSABLE_PREFIX };
