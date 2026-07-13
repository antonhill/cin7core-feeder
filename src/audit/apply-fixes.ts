import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { findSupplierByName } from "@/cin7/suppliers";

export interface ProductFix {
  productId: string;
  /** Suppliers takes the array shape (see products.ts's pushProduct — `{ID, SupplierName}` is the one shape confirmed live to work); `number` supports PriceTierN (see Bulk Pricing, src/app/pricing/actions.ts) and anything else numeric; everything else is a plain scalar. */
  fields: Record<string, string | number | boolean | { ID: string; SupplierName: string }[]>;
}

export interface ApplyFixesResult {
  succeeded: number;
  failed: { productId: string; error: string }[];
}

/**
 * Writes a bulk fix straight to the audited Cin7 instance — no canonical-DB
 * detour (Anton: fix the account you're actually looking at). Each PUT only
 * carries the ID plus the field(s) being fixed, on the same assumption
 * already confirmed live for Customer (src/cin7/customers.ts): Cin7 only
 * changes the fields present in the body and leaves everything else on the
 * record untouched. That's been verified for Customer specifically, not
 * Product — worth confirming on one product here before trusting it at
 * scale, since a wrong assumption would mean silently clearing fields on
 * real data rather than just fixing the intended one. One product's failure
 * doesn't stop the rest of the batch.
 */
export async function applyProductFixes(creds: Cin7Credentials, fixes: ProductFix[]): Promise<ApplyFixesResult> {
  let succeeded = 0;
  const failed: { productId: string; error: string }[] = [];
  for (const fix of fixes) {
    try {
      await cin7Request(creds, "/Product", { method: "PUT", body: { ID: fix.productId, ...fix.fields } });
      succeeded++;
    } catch (e) {
      failed.push({ productId: fix.productId, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }
  return { succeeded, failed };
}

/**
 * Merges a group of near-duplicate values in a single-value field (Category,
 * DefaultUnitOfMeasure) into one: re-fetches the live product list (rather
 * than trusting IDs from an earlier scan, which could be stale) and re-tags
 * every product currently set to any of `fromValues` to `toValue`. Doesn't
 * touch any reference-book entry the old value(s) leave behind — Cin7's own
 * UI makes deleting an unused entry straightforward, and doing it ourselves
 * here risks deleting something else still legitimately references.
 */
async function mergeFieldValue(
  creds: Cin7Credentials,
  field: string,
  fromValues: string[],
  toValue: string
): Promise<ApplyFixesResult> {
  const products = await fetchAllProductsWithBom(creds);
  const fromSet = new Set(fromValues);
  const toFix = products.filter((p) => typeof p[field] === "string" && fromSet.has(p[field] as string) && p[field] !== toValue);

  return applyProductFixes(
    creds,
    toFix.map((p) => ({ productId: String(p.ID ?? p.SKU ?? "?"), fields: { [field]: toValue } }))
  );
}

export function mergeCategoryNames(creds: Cin7Credentials, fromNames: string[], toName: string): Promise<ApplyFixesResult> {
  return mergeFieldValue(creds, "Category", fromNames, toName);
}

export function mergeUOMNames(creds: Cin7Credentials, fromNames: string[], toName: string): Promise<ApplyFixesResult> {
  return mergeFieldValue(creds, "UOM", fromNames, toName);
}

export function mergeBrandNames(creds: Cin7Credentials, fromNames: string[], toName: string): Promise<ApplyFixesResult> {
  return mergeFieldValue(creds, "Brand", fromNames, toName);
}

const ATTRIBUTE_SLOT_COUNT = 10;

/**
 * Copies a template product's filled-in AdditionalAttribute1-10 values onto
 * a set of target products — but only into slots that are currently blank
 * on each target, so an existing (possibly deliberately different) value on
 * a target is never clobbered. Re-fetches live data, same reasoning as the
 * other merge helpers: IDs/values from an earlier scan could be stale.
 */
export async function applyAttributeTemplate(
  creds: Cin7Credentials,
  templateProductId: string,
  targetProductIds: string[]
): Promise<ApplyFixesResult> {
  const products = await fetchAllProductsWithBom(creds);
  const template = products.find((p) => String(p.ID ?? "") === templateProductId);
  if (!template) {
    return { succeeded: 0, failed: targetProductIds.map((productId) => ({ productId, error: "Template product not found." })) };
  }

  const templateValues: Record<string, string> = {};
  for (let slot = 1; slot <= ATTRIBUTE_SLOT_COUNT; slot++) {
    const key = `AdditionalAttribute${slot}`;
    const value = template[key];
    if (typeof value === "string" && value.trim()) templateValues[key] = value;
  }

  const targetIdSet = new Set(targetProductIds);
  const targets = products.filter((p) => targetIdSet.has(String(p.ID ?? "")));

  const fixes: ProductFix[] = [];
  for (const p of targets) {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(templateValues)) {
      const current = p[key];
      if (typeof current !== "string" || !current.trim()) fields[key] = value;
    }
    if (Object.keys(fields).length > 0) fixes.push({ productId: String(p.ID ?? p.SKU ?? "?"), fields });
  }

  return applyProductFixes(creds, fixes);
}

/**
 * Same merge idea, but Tags is a comma-delimited multi-value field — a
 * product can carry several tags at once, so merging means rewriting each
 * affected product's whole Tags string: replace any token matching one of
 * `fromNames` with `toName`, dedupe, and rejoin. Only products that actually
 * carry one of the from-names are touched.
 */
export async function mergeTagNames(creds: Cin7Credentials, fromNames: string[], toName: string): Promise<ApplyFixesResult> {
  const products = await fetchAllProductsWithBom(creds);
  const fromSet = new Set(fromNames);

  const fixes: ProductFix[] = [];
  for (const p of products) {
    if (typeof p.Tags !== "string" || !p.Tags) continue;
    const tokens = p.Tags.split(",");
    if (!tokens.some((t) => fromSet.has(t))) continue;

    const rewritten = tokens.map((t) => (fromSet.has(t) ? toName : t));
    const deduped = [...new Set(rewritten)];
    fixes.push({ productId: String(p.ID ?? p.SKU ?? "?"), fields: { Tags: deduped.join(",") } });
  }

  return applyProductFixes(creds, fixes);
}

/**
 * Assigns an existing supplier (by name) to a set of products that currently
 * have none — resolves the name to Cin7's own supplier ID once (same
 * `{ID, SupplierName}` shape confirmed live 2026-07-11 in products.ts's
 * pushProduct — no other shape has ever worked), then applies it as one
 * Suppliers-array fix per target product. If the name doesn't resolve, every
 * target fails with the same clear reason rather than silently doing
 * nothing.
 */
export async function applySupplierAssignment(
  creds: Cin7Credentials,
  supplierName: string,
  targetProductIds: string[]
): Promise<ApplyFixesResult> {
  const supplier = await findSupplierByName(creds, supplierName);
  if (!supplier) {
    return {
      succeeded: 0,
      failed: targetProductIds.map((productId) => ({ productId, error: `Supplier "${supplierName}" was not found in this Cin7 instance.` })),
    };
  }

  return applyProductFixes(
    creds,
    targetProductIds.map((productId) => ({
      productId,
      fields: { Suppliers: [{ ID: supplier.id, SupplierName: supplierName }] },
    }))
  );
}
