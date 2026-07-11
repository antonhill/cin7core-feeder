import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import { toCin7BomFields, type CanonicalAssemblyBomLineRow } from "@/cin7/assembly-bom";
import { ensureReferenceExists, REF_BRAND_PATH, REF_CATEGORY_PATH, REF_UOM_PATH } from "@/cin7/reference-lookups";
import { findSupplierByName } from "@/cin7/suppliers";

export interface CanonicalProductRow {
  sku: string;
  name: string;
  description: string | null;
  category_code: string | null;
  brand: string | null;
  uom_code: string | null;
  barcode: string | null;
  active: boolean;
  status: string;
  cin7_type: string;
  costing_method: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  carton_length: number | null;
  carton_width: number | null;
  carton_height: number | null;
  carton_inner_quantity: number | null;
  carton_quantity: number | null;
  weight_units: string | null;
  dimension_units: string | null;
  minimum_before_reorder: number | null;
  reorder_quantity: number | null;
  default_location: string | null;
  last_supplied_by: string | null;
  supplier_product_code: string | null;
  supplier_product_name: string | null;
  supplier_fixed_price: number | null;
  auto_assemble: boolean;
  auto_disassemble: boolean;
  drop_ship: string | null;
  inventory_account: string | null;
  revenue_account: string | null;
  expense_account: string | null;
  cogs_account: string | null;
  product_attribute_set: string | null;
  additional_attribute_1: string | null;
  additional_attribute_2: string | null;
  additional_attribute_3: string | null;
  additional_attribute_4: string | null;
  additional_attribute_5: string | null;
  additional_attribute_6: string | null;
  additional_attribute_7: string | null;
  additional_attribute_8: string | null;
  additional_attribute_9: string | null;
  additional_attribute_10: string | null;
  discount_name: string | null;
  comma_delimited_tags: string | null;
  stock_locator: string | null;
  purchase_tax_rule: string | null;
  sale_tax_rule: string | null;
  short_description: string | null;
  sellable: boolean;
  pick_zones: string | null;
  always_show_quantity: number | null;
  internal_note: string | null;
  hs_code: string | null;
  country_of_origin: string | null;
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
    Brand: product.brand ?? undefined,
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
    Description: product.description ?? undefined,
    // Everything below was confirmed against a real live GET /Product
    // response before being added to the push payload — see
    // src/model/products.ts's CanonicalProduct for the fields deliberately
    // held back because their live field name isn't confirmed yet.
    Length: product.length ?? undefined,
    Width: product.width ?? undefined,
    Height: product.height ?? undefined,
    Weight: product.weight ?? undefined,
    CartonLength: product.carton_length ?? undefined,
    CartonWidth: product.carton_width ?? undefined,
    CartonHeight: product.carton_height ?? undefined,
    CartonInnerQuantity: product.carton_inner_quantity ?? undefined,
    CartonQuantity: product.carton_quantity ?? undefined,
    WeightUnits: product.weight_units ?? undefined,
    // Cin7's write-side field is "DimensionsUnits" (with an "s") — differs
    // from the CSV template's own "DimensionUnits" column name, confirmed
    // from a real live GET /Product response.
    DimensionsUnits: product.dimension_units ?? undefined,
    MinimumBeforeReorder: product.minimum_before_reorder ?? undefined,
    ReorderQuantity: product.reorder_quantity ?? undefined,
    DefaultLocation: product.default_location ?? undefined,
    AutoAssembly: product.auto_assemble,
    AutoDisassembly: product.auto_disassemble,
    DropShipMode: product.drop_ship ?? undefined,
    // References an existing Chart of Accounts code — never auto-created
    // (see docs/cin7-api-findings.md §5: Cin7 blocks account writes when
    // Xero/QuickBooks integration is enabled). A rejection here is a real
    // client config gap to surface, not something to paper over.
    InventoryAccount: product.inventory_account ?? undefined,
    RevenueAccount: product.revenue_account ?? undefined,
    ExpenseAccount: product.expense_account ?? undefined,
    COGSAccount: product.cogs_account ?? undefined,
    AttributeSet: product.product_attribute_set ?? undefined,
    AdditionalAttribute1: product.additional_attribute_1 ?? undefined,
    AdditionalAttribute2: product.additional_attribute_2 ?? undefined,
    AdditionalAttribute3: product.additional_attribute_3 ?? undefined,
    AdditionalAttribute4: product.additional_attribute_4 ?? undefined,
    AdditionalAttribute5: product.additional_attribute_5 ?? undefined,
    AdditionalAttribute6: product.additional_attribute_6 ?? undefined,
    AdditionalAttribute7: product.additional_attribute_7 ?? undefined,
    AdditionalAttribute8: product.additional_attribute_8 ?? undefined,
    AdditionalAttribute9: product.additional_attribute_9 ?? undefined,
    AdditionalAttribute10: product.additional_attribute_10 ?? undefined,
    DiscountRule: product.discount_name ?? undefined,
    Tags: product.comma_delimited_tags ?? undefined,
    StockLocator: product.stock_locator ?? undefined,
    PurchaseTaxRule: product.purchase_tax_rule ?? undefined,
    SaleTaxRule: product.sale_tax_rule ?? undefined,
    ShortDescription: product.short_description ?? undefined,
    Sellable: product.sellable,
    PickZones: product.pick_zones ?? undefined,
    AlwaysShowQuantity: product.always_show_quantity ?? undefined,
    InternalNote: product.internal_note ?? undefined,
    HSCode: product.hs_code ?? undefined,
    CountryOfOrigin: product.country_of_origin ?? undefined,
  };
  // Suppliers is deliberately NOT built here even though it's a plain field
  // on the Product resource like everything else above — it needs a live
  // supplier-name -> ID lookup (see pushProduct's own comment), which this
  // function can't do since it's a pure, synchronous mapping with no I/O.
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
/** Resolves a supplier's real Cin7 ID by name, caching both hits and misses so a supplier referenced by many product rows only needs one live lookup per sync run. */
async function resolveSupplierId(creds: Cin7Credentials, name: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(name)) return cache.get(name) ?? null;
  const found = await findSupplierByName(creds, name);
  const id = found?.id ?? null;
  cache.set(name, id);
  return id;
}

export async function pushProduct(
  creds: Cin7Credentials,
  product: CanonicalProductRow,
  priceTiers: CanonicalPriceTierRow[] = [],
  bomLines: CanonicalAssemblyBomLineRow[] = [],
  cin7IdCache: Map<string, string | null | undefined> = new Map(),
  refCache: Set<string> = new Set(),
  supplierIdCache: Map<string, string | null> = new Map()
): Promise<{ cin7Id: string; status: ProductPushStatus }> {
  if (bomLines.length) {
    await resolveComponentIds(
      creds,
      bomLines.map((l) => l.component_sku),
      cin7IdCache
    );
  }
  // Confirmed live: POST/PUT /Product rejects an unrecognized Category
  // ("Category not found.") or Brand ("Brand '...' was not found in
  // reference book") — unlike Cin7's own UI/CSV import, which auto-creates
  // these. Create them first so the product push itself never needs to
  // guess whether the reference-book entry already exists. UOM gets the
  // same treatment pre-emptively, since it's the same kind of reference-book
  // field even though it hasn't been observed failing live yet.
  if (product.category_code) await ensureReferenceExists(creds, REF_CATEGORY_PATH, product.category_code, refCache);
  if (product.brand) await ensureReferenceExists(creds, REF_BRAND_PATH, product.brand, refCache);
  if (product.uom_code) await ensureReferenceExists(creds, REF_UOM_PATH, product.uom_code, refCache);
  const payload = { ...toCin7ProductPayload(product, priceTiers), ...toCin7BomFields(bomLines, cin7IdCache) };
  // Confirmed live 2026-07-11 (Casa das Natas): unlike Category/Brand/UOM,
  // Cin7 rejects a Suppliers entry with just SupplierName ("Suppliers is
  // invalid") — it needs a resolved supplier ID under the generic key `ID`
  // (not `SupplierID`, despite that being the name a community client's
  // documented example used). A supplier that hasn't been pushed yet in
  // this same sync run (suppliers are their own later step — see
  // run-sync.ts) simply can't be resolved; skip Suppliers for now rather
  // than send a request already known to fail — a later sync run picks it
  // up once the supplier exists.
  let suppliers: { ID: string; SupplierName: string }[] | undefined;
  if (product.last_supplied_by) {
    const supplierId = await resolveSupplierId(creds, product.last_supplied_by, supplierIdCache);
    // `{ID, SupplierName}` is the only shape ever confirmed live to work.
    // `SupplierInventoryCode`/`SupplierProductName`/`FixedCost` were added
    // speculatively from a third-party client's schema (see
    // docs/cin7-api-findings.md §5c) without a live write test, and turned
    // out to be wrong — left capture-only in our own DB until independently
    // confirmed.
    if (supplierId) suppliers = [{ ID: supplierId, SupplierName: product.last_supplied_by }];
  }

  const existing = await findProductBySku(creds, product.sku);

  if (existing) {
    const updated = await cin7Request<Cin7ProductResponse>(creds, "/Product", {
      method: "PUT",
      body: { ID: existing.id, ...payload, ...(suppliers ? { Suppliers: suppliers } : {}) },
    });
    return { cin7Id: requireId(updated, "PUT /Product"), status: "updated" };
  }

  // Confirmed live 2026-07-11 (Casa das Natas, all 23 currently-failing
  // products, not a small sample): Cin7's POST /Product — unlike PUT —
  // rejects an inline Suppliers array outright ("Suppliers is invalid"),
  // regardless of its shape or fields. Every prior "confirmed working" test
  // of the Suppliers shape (including the multi-shape live diagnostic) was
  // run as a PUT against an existing product, never a fresh POST, which is
  // why this went unnoticed. Create without Suppliers first, then a
  // follow-up PUT (now that the product exists) attaches it — mirroring
  // exactly the update path above, which is already proven to work.
  const created = await cin7Request<Cin7ProductResponse>(creds, "/Product", {
    method: "POST",
    body: payload,
  });
  const newId = requireId(created, "POST /Product");
  if (suppliers) {
    // Full payload again, not just {ID, Suppliers} — see suppliers.ts's
    // "blank-clears-field" rule: Cin7's PUT isn't a partial PATCH, an
    // omitted optional field gets cleared to blank/default, not left
    // untouched. A minimal body here would wipe out everything else this
    // product was just created with.
    await cin7Request<Cin7ProductResponse>(creds, "/Product", {
      method: "PUT",
      body: { ID: newId, ...payload, Suppliers: suppliers },
    });
  }
  return { cin7Id: newId, status: "created" };
}
