import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import { toCin7BomFields, type CanonicalAssemblyBomLineRow } from "@/cin7/assembly-bom";
import { ensureCategoryExists } from "@/cin7/categories";

export interface CanonicalProductRow {
  sku: string;
  name: string;
  description: string | null;
  category_code: string | null;
  uom_code: string | null;
  barcode: string | null;
  active: boolean;
  status: string;
  cin7_type: string;
  costing_method: string;
}

export interface CanonicalPriceTierRow {
  tier_code: string;
  amount: number;
}

interface Cin7ProductListResponse {
  Products?: { ID: string; SKU?: string }[];
}

/**
 * A live sandbox test showed PUT/POST /Product actually returns the same
 * wrapped-list shape as GET ({Total, Page, Products: [...]}), not a bare
 * {ID: ...} object as first assumed. Accept both shapes defensively since
 * POST's exact response hasn't been separately confirmed.
 */
interface Cin7ProductResponse {
  ID?: string;
  Products?: { ID: string }[];
}

/**
 * Best-effort field mapping — Cin7's confirmed CSV bulk-import column names
 * (ProductCode, Category, DefaultUnitOfMeasure, PriceTier1-10) are NOT
 * necessarily the same as the JSON REST API's field names. This mapping is
 * the starting guess; verify against a live sandbox (400 validation errors
 * name the expected field) and correct here before trusting it in
 * production. See docs/cin7-api-findings.md.
 */
export function toCin7ProductPayload(product: CanonicalProductRow, priceTiers: CanonicalPriceTierRow[] = []) {
  const payload: Record<string, unknown> = {
    SKU: product.sku,
    Name: product.name,
    Category: product.category_code ?? undefined,
    UOM: product.uom_code ?? undefined,
    Barcode: product.barcode ?? undefined,
    // Sent verbatim (not derived from `active`) — Cin7 supports statuses
    // beyond Active/Inactive, e.g. "Deprecated" as the product-level
    // soft-delete mechanism, confirmed by the client.
    Status: product.status,
    // Both required on create — confirmed live via 400 "Required attribute
    // ... not provided" for brand-new SKUs (existing products update fine
    // without them, which is why this was missed until create traffic hit).
    // Type is sent verbatim (not reverse-mapped from our internal category)
    // — reverse-mapping was lossy and silently turned Service products into
    // Stock on every push, confirmed live.
    Type: product.cin7_type,
    CostingMethod: product.costing_method,
  };
  let anyTierSet = false;
  for (const tier of priceTiers) {
    const index = Number(tier.tier_code.replace(/^Tier/, ""));
    if (Number.isInteger(index) && index >= 1 && index <= 10) {
      payload[`PriceTier${index}`] = tier.amount;
      anyTierSet = true;
    }
  }
  // Cin7 rejects create with "PriceTiers value cannot be empty" if no
  // PriceTierN field is present at all — confirmed live for components that
  // only exist as BOM inputs and were never given a sale price. Default to 0
  // rather than requiring every internal-only component to have one.
  if (!anyTierSet) payload.PriceTier1 = 0;
  return payload;
}

/**
 * Looks up a product by SKU. Returns null if it doesn't exist in this Cin7
 * instance yet.
 *
 * SAFETY: the `SKU` query param name/behaviour on GET /Product is
 * unverified — if Cin7 silently ignores an unrecognized filter param, this
 * would return an arbitrary product instead of erroring, and treating that
 * as "found" would make pushProduct overwrite the WRONG product via PUT.
 * So a result only counts as a match if the returned row's own SKU field
 * equals what we searched for — anything else is treated as not-found
 * (falls through to create instead of silently corrupting another record).
 */
export async function findProductBySku(creds: Cin7Credentials, sku: string): Promise<{ id: string } | null> {
  const response = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
    query: { SKU: sku, page: 1, limit: 1 },
  });
  const first = response.Products?.[0];
  if (!first || first.SKU !== sku) return null;
  return { id: first.ID };
}

/**
 * Resolves each SKU's Cin7 product ID, mutating `cache` in place — reused
 * across a whole sync run so a component looked up for one product's BOM
 * doesn't need a second live call for the next. Skus that don't exist in
 * this Cin7 instance yet are simply left unresolved (not an error): the BOM
 * payload falls back to referencing them by SKU/Name alone in that case.
 */
export async function resolveComponentIds(
  creds: Cin7Credentials,
  skus: string[],
  cache: Map<string, string | null | undefined>
): Promise<void> {
  for (const sku of new Set(skus)) {
    if (cache.get(sku)) continue;
    const found = await findProductBySku(creds, sku);
    if (found) cache.set(sku, found.id);
  }
}

/**
 * Fetches every product in this Cin7 instance, with BOM fields included, for
 * a live full-fidelity export (as opposed to the hub's own trimmed canonical
 * export). Paginates until a short page signals the end.
 */
export async function fetchAllProductsWithBom(creds: Cin7Credentials): Promise<Record<string, unknown>[]> {
  const pageSize = 100;
  const all: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ Products?: Record<string, unknown>[] }>(creds, "/Product", {
      query: { page, limit: pageSize, IncludeBOM: "true" },
    });
    const products = response.Products ?? [];
    all.push(...products);
    if (products.length < pageSize) break;
  }
  return all;
}

export type ProductPushStatus = "created" | "updated";

/**
 * Extracts the created/updated record's ID, or throws with the actual
 * response body if the "ID" field mapping assumption turns out to be wrong
 * — surfacing the real shape via sync_state.last_error instead of silently
 * storing cin7_id as null (which happened in a live test run).
 */
function requireId(response: Cin7ProductResponse, action: string): string {
  const id = response.ID ?? response.Products?.[0]?.ID;
  if (!id) {
    throw new Error(`${action} response had no ID field — raw response: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return id;
}

/**
 * Create-or-update a product by SKU. Cin7 has no single upsert call — this
 * does the GET-then-branch itself. Assembly BOM lines (if any) are merged
 * into the same payload — Cin7 has no separate BOM endpoint; BOM fields
 * live directly on the Product resource. See assembly-bom.ts.
 */
export async function pushProduct(
  creds: Cin7Credentials,
  product: CanonicalProductRow,
  priceTiers: CanonicalPriceTierRow[] = [],
  bomLines: CanonicalAssemblyBomLineRow[] = [],
  cin7IdCache: Map<string, string | null | undefined> = new Map(),
  categoryCache: Set<string> = new Set()
): Promise<{ cin7Id: string; status: ProductPushStatus }> {
  if (bomLines.length) {
    await resolveComponentIds(
      creds,
      bomLines.map((l) => l.component_sku),
      cin7IdCache
    );
  }
  // Confirmed live: POST/PUT /Product rejects an unrecognized Category with
  // "Category not found." — unlike Cin7's own UI/CSV import, which
  // auto-creates one. Create it first so the product push itself never
  // needs to guess whether the category already exists.
  if (product.category_code) {
    await ensureCategoryExists(creds, product.category_code, categoryCache);
  }
  const payload = { ...toCin7ProductPayload(product, priceTiers), ...toCin7BomFields(bomLines, cin7IdCache) };
  const existing = await findProductBySku(creds, product.sku);

  if (existing) {
    const updated = await cin7Request<Cin7ProductResponse>(creds, "/Product", {
      method: "PUT",
      body: { ID: existing.id, ...payload },
    });
    return { cin7Id: requireId(updated, "PUT /Product"), status: "updated" };
  }

  const created = await cin7Request<Cin7ProductResponse>(creds, "/Product", {
    method: "POST",
    body: payload,
  });
  return { cin7Id: requireId(created, "POST /Product"), status: "created" };
}
