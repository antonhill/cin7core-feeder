import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

export interface CanonicalProductRow {
  sku: string;
  name: string;
  description: string | null;
  category_code: string | null;
  uom_code: string | null;
  barcode: string | null;
  active: boolean;
}

export interface CanonicalPriceTierRow {
  tier_code: string;
  amount: number;
}

interface Cin7ProductListResponse {
  Products?: { ID: string; SKU?: string }[];
}

interface Cin7ProductResponse {
  ID: string;
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
    Status: product.active ? "Active" : "Inactive",
  };
  for (const tier of priceTiers) {
    const index = Number(tier.tier_code.replace(/^Tier/, ""));
    if (Number.isInteger(index) && index >= 1 && index <= 10) payload[`PriceTier${index}`] = tier.amount;
  }
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

export type ProductPushStatus = "created" | "updated";

/** Create-or-update a product by SKU. Cin7 has no single upsert call — this does the GET-then-branch itself. */
export async function pushProduct(
  creds: Cin7Credentials,
  product: CanonicalProductRow,
  priceTiers: CanonicalPriceTierRow[] = []
): Promise<{ cin7Id: string; status: ProductPushStatus }> {
  const payload = toCin7ProductPayload(product, priceTiers);
  const existing = await findProductBySku(creds, product.sku);

  if (existing) {
    const updated = await cin7Request<Cin7ProductResponse>(creds, "/Product", {
      method: "PUT",
      body: { ID: existing.id, ...payload },
    });
    return { cin7Id: updated.ID, status: "updated" };
  }

  const created = await cin7Request<Cin7ProductResponse>(creds, "/Product", {
    method: "POST",
    body: payload,
  });
  return { cin7Id: created.ID, status: "created" };
}
