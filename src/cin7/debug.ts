import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

interface Cin7ProductListResponse {
  Products?: Record<string, unknown>[];
}

export interface PathProbeResult {
  path: string;
  status: number;
  looksLikeJson: boolean;
  snippet: string;
}

/**
 * Diagnostic only: /production/workcenters keeps returning Cin7's branded
 * "Page not found" HTML (HTTP 200) despite the path being confirmed by two
 * independent secondary sources and the account genuinely having Work
 * Centres configured. Rather than keep guessing from secondary sources,
 * this tries several plausible casing/path variants directly against the
 * live account and reports which one(s) actually return JSON.
 */
export async function probeWorkCentrePaths(creds: Cin7Credentials): Promise<PathProbeResult[]> {
  const candidates = [
    "/production/workcenters",
    "/production/workCenters",
    "/production/WorkCenters",
    "/production/Workcenters",
    "/production/workcentres",
    "/production/workCentres",
    "/WorkCenters",
    "/Workcenters",
  ];

  const results: PathProbeResult[] = [];
  for (const path of candidates) {
    const url = new URL(`${creds.baseUrl.replace(/\/$/, "")}${path}`);
    url.searchParams.set("Page", "1");
    url.searchParams.set("Limit", "100");
    url.searchParams.set("Name", "");

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "api-auth-accountid": creds.accountId,
          "api-auth-applicationkey": creds.applicationKey,
          Accept: "application/json",
        },
      });
      const text = await response.text();
      let looksLikeJson = false;
      try {
        JSON.parse(text);
        looksLikeJson = true;
      } catch {
        looksLikeJson = false;
      }
      results.push({ path, status: response.status, looksLikeJson, snippet: text.slice(0, 150) });
    } catch (e) {
      results.push({ path, status: 0, looksLikeJson: false, snippet: e instanceof Error ? e.message : "network error" });
    }
    // Space these out — this is 8 extra calls against Cin7's 60/min limit.
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  return results;
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

interface Cin7CustomerListResponse {
  CustomerList?: Record<string, unknown>[];
}
interface Cin7SupplierListResponse {
  SupplierList?: Record<string, unknown>[];
}

/**
 * Diagnostic only: confirms /customer and /supplier exist and returns one
 * real example of each, live, before building the push client — same
 * "verify against a real response, not just community docs" step used for
 * Product/BOM. Community-sourced docs (github.com/nnhansg/dear-openapi,
 * github.com/FalconEyeSolutions/CIN7-DearInventory) say both endpoints
 * return a top-level list keyed `CustomerList`/`SupplierList` (matching the
 * `Products` convention) with `Addresses[]`/`Contacts[]` nested per record —
 * unconfirmed until a real response is inspected.
 */
export async function findCustomerAndSupplierExamples(
  creds: Cin7Credentials
): Promise<{ customer?: Record<string, unknown>; supplier?: Record<string, unknown>; rawKeys: { customer: string[]; supplier: string[] } }> {
  const customerRes = await cin7Request<Cin7CustomerListResponse & Record<string, unknown>>(creds, "/customer", {
    query: { page: 1, limit: 1 },
  });
  const supplierRes = await cin7Request<Cin7SupplierListResponse & Record<string, unknown>>(creds, "/supplier", {
    query: { page: 1, limit: 1 },
  });

  return {
    customer: customerRes.CustomerList?.[0],
    supplier: supplierRes.SupplierList?.[0],
    rawKeys: { customer: Object.keys(customerRes), supplier: Object.keys(supplierRes) },
  };
}
