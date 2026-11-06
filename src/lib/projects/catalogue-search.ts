import "server-only";
// Catalogue search for choosing Cin7 products (variation scope today; Solution Builder mapping later). Reads the synced LOCAL catalogue (`products`)
// and stock cache (`product_availability`); org-scoped; no Cin7 call; writes nothing. Stock NEVER filters or blocks a result - it is shown when known.
// A lookup failure THROWS: it is never reported as "no products". Supabase silently caps an unpaged read at 1,000 rows, so every page is read.
import type { createServiceRoleClient } from "@/supabase/server";
import { fetchAllRows } from "@/supabase/fetch-all-rows";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface CatalogueProduct {
  sku: string; name: string; type: string; active: boolean;
  /** Free stock summed over the locations that report it; null = no stock row has ever been synced for this SKU (unknown, NOT zero). */
  available: number | null;
  /** Whether Toolbox can put this on a physical Sales Order line (a stocked product). Services/non-stock are selectable only as commercial scope. */
  stocked: boolean;
}
export type CatalogueOutcome = "FOUND" | "NOT_FOUND" | "TOO_SHORT";
export interface CatalogueResult { outcome: CatalogueOutcome; products: CatalogueProduct[]; detail: string; truncated: boolean }

type ProductRow = { sku: string; name: string | null; cin7_type: string | null; active: boolean | null; status: string | null };
type StockRow = { product_sku: string; location: string; available: number | string | null };

function likeTerm(q: string): string {
  return q.replace(/[,()*"]/g, " ").trim().replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const MIN_CATALOGUE_QUERY = 2;

export async function searchCatalogue(db: Db, orgId: string, query: string, limit = 25): Promise<CatalogueResult> {
  const q = query.trim();
  if (q.length < MIN_CATALOGUE_QUERY) return { outcome: "TOO_SHORT", products: [], detail: `Type at least ${MIN_CATALOGUE_QUERY} characters of the SKU or description.`, truncated: false };
  const term = likeTerm(q);
  const rows = await fetchAllRows<ProductRow>("search catalogue", (from, to) =>
    db.from("products").select("sku, name, cin7_type, active, status").eq("org_id", orgId)
      .or(`sku.ilike.*${term}*,name.ilike.*${term}*`).order("sku").range(from, to));
  const lower = q.toLowerCase();
  const matched = rows.filter((r) => r.sku && (r.sku.toLowerCase().includes(lower) || (r.name ?? "").toLowerCase().includes(lower)));
  const rank = (r: ProductRow) => (r.sku.toLowerCase() === lower ? 0 : r.sku.toLowerCase().startsWith(lower) ? 1 : 2);
  matched.sort((a, b) => rank(a) - rank(b) || (a.sku < b.sku ? -1 : 1));
  const top = matched.slice(0, limit);
  if (top.length === 0) return { outcome: "NOT_FOUND", products: [], detail: `No synced Cin7 product has a SKU or description containing "${q}". Check the spelling, or re-run the catalogue sync if the product is new.`, truncated: false };

  const stock = top.length
    ? await fetchAllRows<StockRow>("catalogue stock", (from, to) =>
        db.from("product_availability").select("product_sku, location, available").eq("org_id", orgId).in("product_sku", top.map((t) => t.sku)).order("product_sku").order("location").range(from, to))
    : [];
  const avail = new Map<string, number>();
  for (const s of stock) {
    const n = Number(s.available);
    if (s.available === null || !Number.isFinite(n)) continue;
    avail.set(s.product_sku, (avail.get(s.product_sku) ?? 0) + n);
  }
  const products = top.map((r): CatalogueProduct => ({
    sku: r.sku, name: r.name ?? "", type: r.cin7_type ?? "Stock", active: r.active !== false && (r.status ?? "Active") !== "Deprecated",
    available: avail.has(r.sku) ? avail.get(r.sku)! : null, stocked: (r.cin7_type ?? "Stock").toLowerCase() === "stock",
  }));
  const truncated = matched.length > limit;
  return { outcome: "FOUND", products, truncated, detail: `${products.length}${truncated ? " of " + matched.length : ""} product${products.length === 1 ? "" : "s"} found.` };
}

export interface ProductSelection { sku: string; quantity: number }
export interface ResolvedProduct { sku: string; description: string; quantity: number }

/**
 * Turns a manager's picked products into the frozen variation scope: every SKU must exist in the org's synced Cin7 catalogue (so a typo can never
 * reach a Sales Order), the description is TAKEN FROM the catalogue (never from the browser), quantities must be positive, duplicates are refused,
 * and only stocked products can be physical lines. Stock levels are deliberately not consulted: an out-of-stock product never blocks a variation.
 * An empty selection is valid (a service-only variation) and invents no SKU.
 */
export async function resolveVariationProducts(db: Db, orgId: string, selections: ProductSelection[]): Promise<ResolvedProduct[]> {
  if (selections.length === 0) return [];
  const seen = new Set<string>();
  for (const s of selections) {
    const sku = (s.sku ?? "").trim();
    if (!sku) throw new Error("Pick a product from the catalogue for every line (or remove the line).");
    if (seen.has(sku)) throw new Error(`${sku} is selected twice; combine it into one line.`);
    seen.add(sku);
    if (!Number.isFinite(s.quantity) || s.quantity <= 0) throw new Error(`Quantity for ${sku} must be a positive number.`);
  }
  const rows = await fetchAllRows<ProductRow>("verify products", (from, to) =>
    db.from("products").select("sku, name, cin7_type, active, status").eq("org_id", orgId).in("sku", [...seen]).order("sku").range(from, to));
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  return selections.map((s) => {
    const sku = s.sku.trim();
    const r = bySku.get(sku);
    if (!r) throw new Error(`${sku} is not in the synced Cin7 catalogue. Search and pick it from the list.`);
    if ((r.cin7_type ?? "Stock").toLowerCase() !== "stock") throw new Error(`${sku} is a ${r.cin7_type} item, not a stocked product. A service-only variation needs no product lines.`);
    if (r.active === false || (r.status ?? "Active") === "Deprecated") throw new Error(`${sku} is inactive in Cin7 and cannot be ordered.`);
    return { sku, description: r.name ?? sku, quantity: s.quantity };
  });
}
