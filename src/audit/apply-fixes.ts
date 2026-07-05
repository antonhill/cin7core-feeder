import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import { fetchAllProductsWithBom } from "@/cin7/products";

export interface ProductFix {
  productId: string;
  fields: Record<string, string>;
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
 * Merges a group of near-duplicate category names into one: re-fetches the
 * live product list (rather than trusting IDs from an earlier scan, which
 * could be stale) and re-tags every product currently under any of
 * `fromNames` to `toName`. Doesn't touch the /ref/category reference-book
 * entry the old name(s) leave behind — Cin7's own UI makes deleting an
 * unused category straightforward, and doing it ourselves here risks
 * deleting a category something else still legitimately references.
 */
export async function mergeCategoryNames(creds: Cin7Credentials, fromNames: string[], toName: string): Promise<ApplyFixesResult> {
  const products = await fetchAllProductsWithBom(creds);
  const fromSet = new Set(fromNames);
  const toFix = products.filter((p) => typeof p.Category === "string" && fromSet.has(p.Category) && p.Category !== toName);

  return applyProductFixes(
    creds,
    toFix.map((p) => ({ productId: String(p.ID ?? p.SKU ?? "?"), fields: { Category: toName } }))
  );
}
