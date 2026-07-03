import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

interface Cin7ProductListResponse {
  Products?: Record<string, unknown>[];
}

/**
 * Diagnostic only (not used by the sync engine): scans this instance's
 * products for one that already has a Bill of Materials configured, and
 * returns its raw JSON — the authoritative shape Cin7 itself produces,
 * useful when guessing at the write-side field schema keeps failing with an
 * uninformative "is invalid" error. Paginates up to a few hundred products.
 */
export async function findProductWithBom(
  creds: Cin7Credentials,
  maxPages = 3,
  pageSize = 100
): Promise<{ found: boolean; product?: Record<string, unknown> }> {
  for (let page = 1; page <= maxPages; page++) {
    const response = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
      query: { page, limit: pageSize, IncludeBOM: "true" },
    });
    const products = response.Products ?? [];
    const match = products.find(
      (p) =>
        p.BillOfMaterial === true ||
        (Array.isArray(p.BillOfMaterialsProducts) && p.BillOfMaterialsProducts.length > 0) ||
        (Array.isArray(p.BillOfMaterialsServices) && p.BillOfMaterialsServices.length > 0)
    );
    if (match) return { found: true, product: match };
    if (products.length < pageSize) break; // last page
  }
  return { found: false };
}
