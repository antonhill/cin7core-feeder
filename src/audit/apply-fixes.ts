import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import { fetchAllProductsWithBom } from "@/cin7/products";

export interface ProductFix {
  productId: string;
  fields: Record<string, string | boolean>;
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
