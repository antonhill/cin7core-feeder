import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request, Cin7ApiError } from "@/cin7/http";
import {
  accountExists,
  companyContactExists,
  locationExists,
  payableAccountExists,
  paymentTermExists,
  priceTierExists,
  receivableAccountExists,
  taxRuleExists,
} from "@/cin7/reference-lookups";
import { fetchAllProductionOrdersList } from "@/cin7/production-orders";
import { fetchAllPurchasesList } from "@/cin7/purchases";
import { updateSaleShipBy } from "@/cin7/sales";

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

/**
 * Diagnostic only: fetches one named customer's raw, current Cin7 record —
 * built to check whether a push actually cleared a field (e.g. DisplayName/
 * AttributeSet) rather than trusting what we *sent*. Cin7's list endpoint
 * matches on an exact-Name filter server-side already (same pattern as
 * `findCustomerByName` in customers.ts, but returning the whole record
 * instead of just the ID).
 */
export async function findCustomerRawByName(creds: Cin7Credentials, name: string): Promise<Record<string, unknown> | null> {
  const response = await cin7Request<Cin7CustomerListResponse>(creds, "/customer", {
    query: { Name: name, page: 1, limit: 1 },
  });
  const first = response.CustomerList?.[0];
  return first && first.Name === name ? first : null;
}

export interface CustomerReferenceFieldsInput {
  location: string | null;
  sales_representative: string | null;
  account_receivable: string | null;
  sale_account: string | null;
  tax_rule: string | null;
  price_tier: string | null;
  payment_term: string | null;
}

export interface ReferenceFieldCheckResult {
  field: string;
  value: string;
  exists: boolean | "not set";
  /** Set only if the check itself failed unexpectedly (e.g. a retryable Cin7 error) — the non-retryable "can't find it" case is already folded into `exists: false` by reference-lookups.ts. */
  checkError?: string;
}

/**
 * Diagnostic only: checks every reference-style field on a customer against
 * this instance's actual reference books, in one shot — built to diagnose a
 * vague "Account with specified ID not found" push error where the
 * pre-flight check (Location/SalesRepresentative/AccountReceivable/
 * SaleAccount, see reference-lookups.ts) had already passed, ruling those
 * four back in as the cause. Adds TaxRule and PriceTier, which aren't part
 * of the pre-flight (deliberately scoped to fields that had actually failed
 * at the time) but are plausible remaining suspects — Cin7's own Tax Rule
 * model links every rule to a Chart-of-Accounts code, so an unresolvable
 * TaxRule could surface as an "Account ..." error without naming TaxRule.
 */
/** Shared by the customer/supplier variants below — runs each named check, tolerating one field's unexpected failure without hiding the rest. */
async function runReferenceFieldChecks(
  checks: { field: string; value: string | null; check: (v: string) => Promise<boolean> }[]
): Promise<ReferenceFieldCheckResult[]> {
  const results: ReferenceFieldCheckResult[] = [];
  for (const { field, value, check } of checks) {
    if (!value) {
      results.push({ field, value: "", exists: "not set" });
      continue;
    }
    // One field's check unexpectedly failing (e.g. a rate-limit hit
    // mid-diagnostic) shouldn't hide whatever the other fields already
    // found — this is exactly the class of bug that made the original push
    // failure look like a Xero mystery: one bad lookup crashing before the
    // rest could even be evaluated.
    try {
      results.push({ field, value, exists: await check(value) });
    } catch (e) {
      results.push({ field, value, exists: "not set", checkError: e instanceof Error ? e.message : "Unknown error" });
    }
  }
  return results;
}

export async function checkCustomerReferenceFields(
  creds: Cin7Credentials,
  fields: CustomerReferenceFieldsInput
): Promise<ReferenceFieldCheckResult[]> {
  const cache = new Map<string, boolean>();
  return runReferenceFieldChecks([
    { field: "Location", value: fields.location, check: (v) => locationExists(creds, v, cache) },
    { field: "SalesRepresentative", value: fields.sales_representative, check: (v) => companyContactExists(creds, v, cache) },
    { field: "AccountReceivable", value: fields.account_receivable, check: (v) => receivableAccountExists(creds, v, cache) },
    { field: "SaleAccount", value: fields.sale_account, check: (v) => accountExists(creds, v, cache) },
    { field: "TaxRule", value: fields.tax_rule, check: (v) => taxRuleExists(creds, v, cache) },
    { field: "PriceTier", value: fields.price_tier, check: (v) => priceTierExists(creds, v, cache) },
    { field: "PaymentTerm", value: fields.payment_term, check: (v) => paymentTermExists(creds, v, cache) },
  ]);
}

export interface SupplierReferenceFieldsInput {
  account_payable: string | null;
  tax_rule: string | null;
  payment_term: string | null;
}

/** Supplier equivalent — no Location/SalesRepresentative/PriceTier (those fields don't exist on suppliers). */
export async function checkSupplierReferenceFields(
  creds: Cin7Credentials,
  fields: SupplierReferenceFieldsInput
): Promise<ReferenceFieldCheckResult[]> {
  const cache = new Map<string, boolean>();
  return runReferenceFieldChecks([
    { field: "AccountPayable", value: fields.account_payable, check: (v) => payableAccountExists(creds, v, cache) },
    { field: "TaxRule", value: fields.tax_rule, check: (v) => taxRuleExists(creds, v, cache) },
    { field: "PaymentTerm", value: fields.payment_term, check: (v) => paymentTermExists(creds, v, cache) },
  ]);
}

/**
 * Diagnostic only: fetches the full Chart-of-Accounts record(s) for one or
 * more codes and returns them side by side — built to find the real
 * distinguishing field between a code that genuinely works as
 * AccountPayable/AccountReceivable (e.g. "800") and one that exists but
 * still gets rejected by the real push (e.g. "801"), since our own
 * `accountExists` only checks "does this code exist at all" and Cin7's own
 * field docs say AccountPayable/AccountReceivable specifically require
 * "special account [payable/receivable] accounts" — a narrower category
 * than plain existence. `SystemAccount`/`Type`/`Class`/`Status` are the
 * documented candidates; comparing real records settles which one matters
 * instead of guessing.
 */
export async function findAccountsByCodes(creds: Cin7Credentials, codes: string[]): Promise<Record<string, Record<string, unknown> | null>> {
  const results: Record<string, Record<string, unknown> | null> = {};
  for (const code of codes) {
    try {
      const response = await cin7Request<{ AccountsList?: Record<string, unknown>[] }>(creds, "/ref/account", {
        query: { Page: 1, Limit: 100, Code: code },
      });
      results[code] = (response.AccountsList ?? []).find((a) => a.Code === code) ?? null;
    } catch (e) {
      // Confirmed live: GET /ref/account?Code=<no match> can 400 instead of
      // an empty list (see reference-lookups.ts) — treat that the same way
      // as "not found" here rather than crashing the whole comparison.
      if (e instanceof Cin7ApiError && !e.retryable) {
        results[code] = null;
        continue;
      }
      throw e;
    }
  }
  return results;
}

export interface SaleStatusCounts {
  total: number;
  statusCounts: Record<string, number>;
  combinedInvoiceStatusCounts: Record<string, number>;
  sample: Record<string, unknown>[];
}

/**
 * Diagnostic only: the sales sync filters /saleList to
 * CombinedInvoiceStatus=AUTHORISED (Anton confirmed this is what "invoiced"
 * means), but a live sync against a real instance returned zero sales
 * despite the org clearly having invoices. Rather than guess whether
 * AUTHORISED is genuinely never used once an invoice is paid (Cin7's own
 * spec lists AUTHORISED and PAID as distinct CombinedInvoiceStatus values —
 * possibly a status *transition*, not an overlapping pair), this fetches
 * /saleList with NO status filter and tallies what CombinedInvoiceStatus
 * values actually appear on this instance's real sales.
 */
export async function checkSaleStatuses(creds: Cin7Credentials): Promise<SaleStatusCounts> {
  const response = await cin7Request<{ Total?: number; SaleList?: Record<string, unknown>[] }>(creds, "/saleList", {
    query: { Page: 1, Limit: 100 },
  });
  const sales = response.SaleList ?? [];

  const statusCounts: Record<string, number> = {};
  const combinedInvoiceStatusCounts: Record<string, number> = {};
  for (const sale of sales) {
    const status = String(sale.Status ?? "(none)");
    const invoiceStatus = String(sale.CombinedInvoiceStatus ?? "(none)");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    combinedInvoiceStatusCounts[invoiceStatus] = (combinedInvoiceStatusCounts[invoiceStatus] ?? 0) + 1;
  }

  return {
    total: response.Total ?? sales.length,
    statusCounts,
    combinedInvoiceStatusCounts,
    sample: sales.slice(0, 3),
  };
}

export interface FinishedGoodsExample {
  listRecord?: Record<string, unknown>;
  listKeys: string[];
  detail?: Record<string, unknown>;
  detailError?: string;
}

/**
 * Diagnostic only: Anton asked for assembly quantity ("how many items
 * planned/being built") and total BOM cost on the new Assemblies report —
 * neither field is confirmed anywhere yet. `Cin7FinishedGoodsListEntry`
 * (finished-goods.ts) only types TaskID/AssemblyNumber/ProductCode/
 * ProductName/Status/Date, but the *real* list response may already carry
 * more fields our narrow interface just doesn't expose — same class of gap
 * that missed Product's Brand/CostingMethod early on (see
 * docs/cin7-api-findings.md). This dumps one full raw list record (every
 * key, not just the typed subset) AND attempts a plausible detail endpoint —
 * `/finishedgoods?TaskID=`, guessing at the same lowercase-singular +
 * `{Resource}ID`-param pattern already confirmed for Stock Transfer
 * (`/stocktransfer?TaskID=`) — unconfirmed, so both are reported rather than
 * guessed at blind.
 */
export async function findFinishedGoodsExample(creds: Cin7Credentials): Promise<FinishedGoodsExample> {
  const listRes = await cin7Request<{ FinishedGoods?: Record<string, unknown>[] }>(creds, "/finishedGoodsList", {
    query: { Page: 1, Limit: 1 },
  });
  const listRecord = listRes.FinishedGoods?.[0];
  const listKeys = listRecord ? Object.keys(listRecord) : [];

  let detail: Record<string, unknown> | undefined;
  let detailError: string | undefined;
  const taskId = listRecord?.TaskID;
  if (taskId) {
    try {
      detail = await cin7Request<Record<string, unknown>>(creds, "/finishedgoods", { query: { TaskID: String(taskId) } });
    } catch (e) {
      detailError = e instanceof Error ? e.message : "Unknown error";
    }
  }

  return { listRecord, listKeys, detail, detailError };
}

export interface FinishedGoodsFieldSurvey {
  recordsScanned: number;
  detailsFetched: number;
  detailFetchErrors: { taskId: string; error: string }[];
  listKeys: string[];
  detailKeys: string[];
  /** One non-empty example value per detail key seen, so a newly-discovered key's real shape is visible without a second round trip. */
  detailKeyExamples: Record<string, unknown>;
}

/**
 * Diagnostic only: Anton asked for components + resources/additional costs
 * per assembly, with an actual/estimated total. `OrderLines`/`PickLines` are
 * confirmed (see Cin7FinishedGoodsDetail in finished-goods.ts), but whether a
 * built assembly's detail response ever carries a services/resources/labor
 * array (parallel to Product BOM's confirmed `BillOfMaterialsServices[]`) is
 * NOT confirmed — the one example checked so far had no services attached,
 * and Cin7 appears to omit empty arrays rather than send them empty, so
 * absence there doesn't prove absence generally. Scans several list records
 * and fetches detail for a handful of them (prioritizing different products,
 * since different BOMs are more likely to expose a field only some records
 * carry), then reports the UNION of every key seen — if a services/resources
 * field exists on ANY scanned assembly, it'll show up here even though it
 * didn't on the single-record diagnostic.
 */
export async function surveyFinishedGoodsFields(
  creds: Cin7Credentials,
  maxRecords = 25,
  maxDetails = 6
): Promise<FinishedGoodsFieldSurvey> {
  const listRes = await cin7Request<{ FinishedGoods?: Record<string, unknown>[] }>(creds, "/finishedGoodsList", {
    query: { Page: 1, Limit: maxRecords },
  });
  const records = listRes.FinishedGoods ?? [];

  const listKeySet = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) listKeySet.add(key);
  }

  // Prefer records for distinct products — a services/resources line is a
  // property of that product's BOM, so different products are more likely to
  // surface a field a single product's assemblies never would.
  const seenProducts = new Set<string>();
  const toFetch: Record<string, unknown>[] = [];
  for (const record of records) {
    const productCode = String(record.ProductCode ?? record.TaskID ?? "");
    if (seenProducts.has(productCode)) continue;
    seenProducts.add(productCode);
    toFetch.push(record);
    if (toFetch.length >= maxDetails) break;
  }

  const detailKeySet = new Set<string>();
  const detailKeyExamples: Record<string, unknown> = {};
  const detailFetchErrors: { taskId: string; error: string }[] = [];
  for (const record of toFetch) {
    const taskId = String(record.TaskID ?? "");
    if (!taskId) continue;
    try {
      const detail = await cin7Request<Record<string, unknown>>(creds, "/finishedgoods", { query: { TaskID: taskId } });
      for (const [key, value] of Object.entries(detail)) {
        detailKeySet.add(key);
        const isEmpty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
        if (!isEmpty && detailKeyExamples[key] === undefined) detailKeyExamples[key] = value;
      }
    } catch (e) {
      detailFetchErrors.push({ taskId, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return {
    recordsScanned: records.length,
    detailsFetched: toFetch.length,
    detailFetchErrors,
    listKeys: [...listKeySet].sort(),
    detailKeys: [...detailKeySet].sort(),
    detailKeyExamples,
  };
}

export interface CostBasisFieldSurvey {
  productsScanned: number;
  averageCostSeenCount: number;
  averageCostNonZeroCount: number;
  averageCostMin?: number;
  averageCostMax?: number;
  suppliersArrayPresentCount: number;
  suppliersNonEmptyCount: number;
  supplierKeys: string[];
  supplierKeyExamples: Record<string, unknown>;
  /** Hypothesis: like IncludeBOM, maybe Suppliers needs an explicit include flag on the bulk list call. */
  includeSuppliersVariant: {
    productsScanned: number;
    suppliersNonEmptyCount: number;
    supplierKeys: string[];
    supplierKeyExamples: Record<string, unknown>;
  };
  /** Hypothesis: maybe a single-product fetch (filtered by SKU, same shape findProductBySku already uses) returns richer data than a bulk list row for the same product. */
  detailCheckSamples: {
    sku: string;
    bulkListSuppliersLength: number;
    detailSuppliersLength: number;
    detailKeys: string[];
  }[];
}

/**
 * Diagnostic only: the cost estimator's toggleable basis (Average / Latest /
 * Fixed) needs `AverageCost` on Product and `Suppliers[].Cost`/`FixedCost`.
 * `AverageCost` has only ever been confirmed via CSV import in this codebase
 * (see docs/cin7-api-findings.md's "Capture-only" section) — never on a live
 * GET /Product response — and a first pass of this survey found `Suppliers`
 * empty on every one of 50 scanned products. That's ambiguous: either this
 * account genuinely has no supplier records set up yet, or (same pattern as
 * `IncludeBOM=true`) the bulk list call omits related data unless explicitly
 * asked for. This version tests both explanations directly instead of
 * guessing further from official docs alone (which 403'd when fetched) —
 * same discipline as every other survey* function here.
 */
function scanSupplierFields(products: Record<string, unknown>[], bulkSuppliersLengthBySku?: Map<string, number>) {
  let suppliersArrayPresentCount = 0;
  let suppliersNonEmptyCount = 0;
  const supplierKeySet = new Set<string>();
  const supplierKeyExamples: Record<string, unknown> = {};

  for (const raw of products) {
    if ("Suppliers" in raw) suppliersArrayPresentCount++;
    const suppliers = raw.Suppliers;
    const len = Array.isArray(suppliers) ? suppliers.length : 0;
    if (bulkSuppliersLengthBySku) {
      const sku = String(raw.SKU ?? "");
      if (sku) bulkSuppliersLengthBySku.set(sku, len);
    }
    if (len > 0) {
      suppliersNonEmptyCount++;
      for (const supplier of suppliers as unknown[]) {
        if (!supplier || typeof supplier !== "object") continue;
        for (const [key, value] of Object.entries(supplier as Record<string, unknown>)) {
          supplierKeySet.add(key);
          const isEmpty = value === null || value === undefined;
          if (!isEmpty && supplierKeyExamples[key] === undefined) supplierKeyExamples[key] = value;
        }
      }
    }
  }

  return { suppliersArrayPresentCount, suppliersNonEmptyCount, supplierKeySet, supplierKeyExamples };
}

export async function surveyCostBasisFields(creds: Cin7Credentials, maxRecords = 50): Promise<CostBasisFieldSurvey> {
  const response = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
    query: { page: 1, limit: maxRecords, IncludeBOM: "true" },
  });
  const products = (response.Products ?? []) as Record<string, unknown>[];

  let averageCostSeenCount = 0;
  let averageCostNonZeroCount = 0;
  let averageCostMin: number | undefined;
  let averageCostMax: number | undefined;

  for (const raw of products) {
    const averageCost = raw.AverageCost;
    if (averageCost !== null && averageCost !== undefined) {
      averageCostSeenCount++;
      if (typeof averageCost === "number") {
        if (averageCost !== 0) averageCostNonZeroCount++;
        averageCostMin = averageCostMin === undefined ? averageCost : Math.min(averageCostMin, averageCost);
        averageCostMax = averageCostMax === undefined ? averageCost : Math.max(averageCostMax, averageCost);
      }
    }
  }

  const bulkSuppliersLengthBySku = new Map<string, number>();
  const bulkScan = scanSupplierFields(products, bulkSuppliersLengthBySku);

  const variantResponse = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
    query: { page: 1, limit: maxRecords, IncludeBOM: "true", IncludeSuppliers: "true" },
  });
  const variantProducts = (variantResponse.Products ?? []) as Record<string, unknown>[];
  const variantScan = scanSupplierFields(variantProducts);

  const sampleSkus = [...bulkSuppliersLengthBySku.keys()].slice(0, 5);
  const detailCheckSamples: CostBasisFieldSurvey["detailCheckSamples"] = [];
  for (const sku of sampleSkus) {
    try {
      const detailResponse = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
        query: { SKU: sku, page: 1, limit: 1 },
      });
      const detail = detailResponse.Products?.[0] as Record<string, unknown> | undefined;
      const detailSuppliers = detail?.Suppliers;
      detailCheckSamples.push({
        sku,
        bulkListSuppliersLength: bulkSuppliersLengthBySku.get(sku) ?? 0,
        detailSuppliersLength: Array.isArray(detailSuppliers) ? detailSuppliers.length : 0,
        detailKeys: detail ? Object.keys(detail).sort() : [],
      });
    } catch {
      // Diagnostic only — one bad SKU shouldn't block reporting the others.
    }
  }

  return {
    productsScanned: products.length,
    averageCostSeenCount,
    averageCostNonZeroCount,
    averageCostMin,
    averageCostMax,
    suppliersArrayPresentCount: bulkScan.suppliersArrayPresentCount,
    suppliersNonEmptyCount: bulkScan.suppliersNonEmptyCount,
    supplierKeys: [...bulkScan.supplierKeySet].sort(),
    supplierKeyExamples: bulkScan.supplierKeyExamples,
    includeSuppliersVariant: {
      productsScanned: variantProducts.length,
      suppliersNonEmptyCount: variantScan.suppliersNonEmptyCount,
      supplierKeys: [...variantScan.supplierKeySet].sort(),
      supplierKeyExamples: variantScan.supplierKeyExamples,
    },
    detailCheckSamples,
  };
}

interface Cin7ProductionBomListResponse {
  ProductionBOMs?: Record<string, unknown>[];
}

export interface ProductionBomFieldSurvey {
  productsScanned: number;
  bomTypeValuesSeen: string[];
  /** Products whose BOMType is exactly "Production" — these are what actually got probed, not every scanned product. */
  candidateSkusFound: string[];
  candidatesProbed: number;
  productsWithProductionBom: { sku: string; productId: string; bomType: string; versionCount: number }[];
  productionBomFetchErrors: { sku: string; error: string }[];
  versionKeys: string[];
  operationKeys: string[];
  componentKeys: string[];
  resourceKeys: string[];
  versionKeyExamples: Record<string, unknown>;
  operationKeyExamples: Record<string, unknown>;
  componentKeyExamples: Record<string, unknown>;
  resourceKeyExamples: Record<string, unknown>;
}

/**
 * Confirmed via Cin7's own official API docs (screenshot reviewed 2026-07-08):
 * `BOMType` is a read-only String with exactly 4 valid values — "Assembly",
 * "Production", "Make to Order", "None". Only "Production" is what this
 * survey (and later, the cost estimator's Production BOM extension) cares
 * about; "Make to Order" is a distinct BOM kind, not yet investigated.
 */
const PRODUCTION_BOM_TYPE = "Production";

function collectKeys(records: Record<string, unknown>[], keySet: Set<string>, examples: Record<string, unknown>) {
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      keySet.add(key);
      const isEmpty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
      if (!isEmpty && examples[key] === undefined) examples[key] = value;
    }
  }
}

/**
 * Diagnostic only: the last unconfirmed piece before extending the cost
 * estimator to Production BOMs is what a real
 * `GET /production/productionBOM?ProductID=` response's full Operations/
 * Components/Resources shape looks like — `findProductionBomVersion`
 * (production-bom.ts) already calls this live and reads back `.Version`, so
 * the endpoint itself is confirmed reachable; this just looks at everything
 * else in that same response instead of discarding it. Which products to
 * probe is no longer a guess — `BOMType === "Production"` (confirmed via
 * Cin7's own official API docs) filters the bulk `/Product` scan cheaply,
 * same as `BillOfMaterial: true` already does for Assembly BOM. Resource-
 * level cost (labor/machine rate) is the biggest remaining unknown —
 * Resources may only echo back `ResourceID`/`Quantity` with no rate field,
 * which would mean Production BOM estimates can only ever cover material
 * Components, not labor.
 */
export async function surveyProductionBomFields(
  creds: Cin7Credentials,
  maxProductsToScan = 300,
  maxCandidatesToProbe = 15
): Promise<ProductionBomFieldSurvey> {
  const pageSize = 100;
  const products: Record<string, unknown>[] = [];
  for (let page = 1; products.length < maxProductsToScan; page++) {
    const response = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
      query: { page, limit: pageSize, IncludeBOM: "true" },
    });
    const pageProducts = (response.Products ?? []) as Record<string, unknown>[];
    products.push(...pageProducts);
    if (pageProducts.length < pageSize) break;
  }

  const bomTypeValues = new Set<string>();
  for (const p of products) {
    if (typeof p.BOMType === "string" && p.BOMType) bomTypeValues.add(p.BOMType);
  }

  const candidates = products.filter((p) => p.BOMType === PRODUCTION_BOM_TYPE).slice(0, maxCandidatesToProbe);

  const versionKeySet = new Set<string>();
  const operationKeySet = new Set<string>();
  const componentKeySet = new Set<string>();
  const resourceKeySet = new Set<string>();
  const versionKeyExamples: Record<string, unknown> = {};
  const operationKeyExamples: Record<string, unknown> = {};
  const componentKeyExamples: Record<string, unknown> = {};
  const resourceKeyExamples: Record<string, unknown> = {};
  const productsWithProductionBom: ProductionBomFieldSurvey["productsWithProductionBom"] = [];
  const productionBomFetchErrors: ProductionBomFieldSurvey["productionBomFetchErrors"] = [];

  for (const p of candidates) {
    const productId = String(p.ID ?? "");
    const sku = String(p.SKU ?? "");
    const bomType = String(p.BOMType ?? "");
    if (!productId) continue;
    try {
      const response = await cin7Request<Cin7ProductionBomListResponse>(creds, "/production/productionBOM", {
        query: { ProductID: productId },
      });
      const boms = response.ProductionBOMs ?? [];
      if (boms.length === 0) continue;

      productsWithProductionBom.push({ sku, productId, bomType, versionCount: boms.length });
      collectKeys(boms, versionKeySet, versionKeyExamples);

      const operations = boms.flatMap((b) => (Array.isArray(b.Operations) ? (b.Operations as Record<string, unknown>[]) : []));
      collectKeys(operations, operationKeySet, operationKeyExamples);

      const components = operations.flatMap((o) => (Array.isArray(o.Components) ? (o.Components as Record<string, unknown>[]) : []));
      collectKeys(components, componentKeySet, componentKeyExamples);

      const resources = operations.flatMap((o) => (Array.isArray(o.Resources) ? (o.Resources as Record<string, unknown>[]) : []));
      collectKeys(resources, resourceKeySet, resourceKeyExamples);
    } catch (e) {
      productionBomFetchErrors.push({ sku, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return {
    productsScanned: products.length,
    bomTypeValuesSeen: [...bomTypeValues].sort(),
    candidateSkusFound: candidates.map((p) => String(p.SKU ?? "")),
    candidatesProbed: candidates.length,
    productsWithProductionBom,
    productionBomFetchErrors,
    versionKeys: [...versionKeySet].sort(),
    operationKeys: [...operationKeySet].sort(),
    componentKeys: [...componentKeySet].sort(),
    resourceKeys: [...resourceKeySet].sort(),
    versionKeyExamples,
    operationKeyExamples,
    componentKeyExamples,
    resourceKeyExamples,
  };
}

export interface ProductionBomSkuCheck {
  sku: string;
  found: boolean;
  bomType?: string;
  versionCount: number;
  error?: string;
}

export interface ProductionBomSkuSurvey {
  checks: ProductionBomSkuCheck[];
  versionKeys: string[];
  operationKeys: string[];
  componentKeys: string[];
  resourceKeys: string[];
  versionKeyExamples: Record<string, unknown>;
  operationKeyExamples: Record<string, unknown>;
  componentKeyExamples: Record<string, unknown>;
  resourceKeyExamples: Record<string, unknown>;
}

/**
 * Diagnostic only: unlike surveyProductionBomFields (which discovers
 * candidates by paginating the bulk list), this checks specific SKUs
 * directly — for when the candidates are already known (e.g. from Cin7's
 * own InventoryList CSV export, whose `ProductionBOM` Yes/No column is the
 * same signal as the live API's `BOMType === "Production"`, just easier to
 * search across a full catalog export than to paginate live). Confirmed
 * live 2026-07-08: out of 3669 real products, only 3 actually had
 * `ProductionBOM=Yes` in the CSV — rare enough that a 300-product live
 * bulk-list scan can genuinely miss all of them by chance.
 */
export async function surveyProductionBomForSkus(creds: Cin7Credentials, skus: string[]): Promise<ProductionBomSkuSurvey> {
  const versionKeySet = new Set<string>();
  const operationKeySet = new Set<string>();
  const componentKeySet = new Set<string>();
  const resourceKeySet = new Set<string>();
  const versionKeyExamples: Record<string, unknown> = {};
  const operationKeyExamples: Record<string, unknown> = {};
  const componentKeyExamples: Record<string, unknown> = {};
  const resourceKeyExamples: Record<string, unknown> = {};
  const checks: ProductionBomSkuCheck[] = [];

  for (const sku of skus) {
    try {
      const productResponse = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
        query: { SKU: sku, page: 1, limit: 1 },
      });
      const product = productResponse.Products?.[0] as Record<string, unknown> | undefined;
      if (!product || product.SKU !== sku) {
        checks.push({ sku, found: false, versionCount: 0, error: "Not found in this instance" });
        continue;
      }

      const productId = String(product.ID ?? "");
      const bomType = typeof product.BOMType === "string" ? product.BOMType : undefined;
      if (!productId) {
        checks.push({ sku, found: false, versionCount: 0, bomType, error: "Product has no ID" });
        continue;
      }

      const bomResponse = await cin7Request<Cin7ProductionBomListResponse>(creds, "/production/productionBOM", {
        query: { ProductID: productId },
      });
      const boms = bomResponse.ProductionBOMs ?? [];
      checks.push({ sku, found: true, bomType, versionCount: boms.length });

      collectKeys(boms, versionKeySet, versionKeyExamples);
      const operations = boms.flatMap((b) => (Array.isArray(b.Operations) ? (b.Operations as Record<string, unknown>[]) : []));
      collectKeys(operations, operationKeySet, operationKeyExamples);
      const components = operations.flatMap((o) => (Array.isArray(o.Components) ? (o.Components as Record<string, unknown>[]) : []));
      collectKeys(components, componentKeySet, componentKeyExamples);
      const resources = operations.flatMap((o) => (Array.isArray(o.Resources) ? (o.Resources as Record<string, unknown>[]) : []));
      collectKeys(resources, resourceKeySet, resourceKeyExamples);
    } catch (e) {
      checks.push({ sku, found: false, versionCount: 0, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return {
    checks,
    versionKeys: [...versionKeySet].sort(),
    operationKeys: [...operationKeySet].sort(),
    componentKeys: [...componentKeySet].sort(),
    resourceKeys: [...resourceKeySet].sort(),
    versionKeyExamples,
    operationKeyExamples,
    componentKeyExamples,
    resourceKeyExamples,
  };
}

export interface ProductionOrderDetailSurvey {
  orderNumber: string;
  found: boolean;
  productionOrderId?: string;
  operationCount?: number;
  componentCount?: number;
  resourceCount?: number;
  raw?: unknown;
  error?: string;
}

/**
 * Confirmed via FalconEyeSolutions/CIN7-DearInventory's generated client
 * (ProductionApi.cs, GET /production/order): a completed Manufacture
 * Order's detail returns full nested Operations -> Components/Resources,
 * each carrying real cost fields (Component: Cost/ProductCost/TotalCost;
 * Resource: Cost/ResourceCost/TotalCost) — unlike /production/productionBOM
 * (the BOM *definition*), which surveyProductionBomForSkus found never
 * returns any version/cost data at all on this account. Not yet confirmed
 * live against a real instance — this is that probe, targeting one known
 * order number (e.g. "MO-00036") rather than guessing a SKU/ProductID.
 */
export async function surveyProductionOrderDetail(creds: Cin7Credentials, orderNumber: string): Promise<ProductionOrderDetailSurvey> {
  try {
    const orders = await fetchAllProductionOrdersList(creds);
    const match = orders.find((o) => o.Type === "O" && (o.OrderNumber ?? "").toUpperCase() === orderNumber.toUpperCase());
    if (!match?.ProductionOrderID) {
      return {
        orderNumber,
        found: false,
        error: "No matching Manufacture Order (Type \"O\") found in this instance's production order list",
      };
    }

    const response = await cin7Request<{ ProductionOrders?: Record<string, unknown>[] }>(creds, "/production/order", {
      query: { ProductionOrderID: match.ProductionOrderID, ReturnAttachmentsContent: "false" },
    });
    const order = response.ProductionOrders?.[0];
    const operations = Array.isArray(order?.Operations) ? (order.Operations as Record<string, unknown>[]) : [];
    const components = operations.flatMap((o) => (Array.isArray(o.Components) ? (o.Components as unknown[]) : []));
    const resources = operations.flatMap((o) => (Array.isArray(o.Resources) ? (o.Resources as unknown[]) : []));

    return {
      orderNumber,
      found: true,
      productionOrderId: match.ProductionOrderID,
      operationCount: operations.length,
      componentCount: components.length,
      resourceCount: resources.length,
      raw: response,
    };
  } catch (e) {
    return { orderNumber, found: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ProductionOrderRoutingTaskSurvey {
  orderNumber: string;
  found: boolean;
  productionOrderId?: string;
  /** Every /production/orderList row sharing this order's ProductionOrderID — the Type "O" header row plus any Type "R" routing sub-rows, raw and unfiltered so fields outside Cin7ProductionOrderListEntry's own (deliberately narrow) interface are still visible. */
  matchingRows?: unknown[];
  error?: string;
}

/**
 * Advanced Manufacturing anticipation work (new client, 2026-07-14): neither
 * /production/order (see surveyProductionOrderDetail above) nor its
 * Operations array carries any per-operation progress/status field — an
 * in-progress order's Operations look identical in shape to a completed
 * one's, just static routing/sequence/work-centre data. The one place a
 * finer-grained state COULD live is the Type "R" routing sub-rows this
 * codebase's own fetchAllProductionOrdersList already knows exist
 * (production-orders.ts's own comment: "Each Manufacture Order (Type "O")
 * can have one or more associated Routing sub-rows (Type "R") sharing the
 * same ProductionOrderID but a distinct TaskID") — those have never actually
 * been inspected, only skipped over (every caller filters to Type "O").
 * This dumps every row (Type "O" and any "R" siblings) for one order,
 * unfiltered, to see what a routing sub-row's real fields are — reuses
 * fetchAllProductionOrdersList's already-fetched objects rather than a new
 * request, since a TS interface doesn't strip extra runtime fields from the
 * underlying JSON.
 */
export async function surveyProductionOrderRoutingTasks(creds: Cin7Credentials, orderNumber: string): Promise<ProductionOrderRoutingTaskSurvey> {
  try {
    const orders = await fetchAllProductionOrdersList(creds);
    const match = orders.find((o) => o.Type === "O" && (o.OrderNumber ?? "").toUpperCase() === orderNumber.toUpperCase());
    if (!match?.ProductionOrderID) {
      return {
        orderNumber,
        found: false,
        error: "No matching Manufacture Order (Type \"O\") found in this instance's production order list",
      };
    }

    const matchingRows = orders.filter((o) => o.ProductionOrderID === match.ProductionOrderID);
    return { orderNumber, found: true, productionOrderId: match.ProductionOrderID, matchingRows };
  } catch (e) {
    return { orderNumber, found: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ProductionOrderOperationProbe {
  attempt: string;
  status: number;
  looksLikeJson: boolean;
  /** Only set for the Include*-flag retries against /production/order — each operation's own key set, to diff against the baseline (no extra flag) call. */
  operationKeys?: string[][];
  snippet?: string;
  error?: string;
}

export interface ProductionOrderOperationStatusSurvey {
  orderNumber: string;
  found: boolean;
  productionOrderId?: string;
  operations?: { operationId: string; name: string }[];
  probes: ProductionOrderOperationProbe[];
  error?: string;
}

// Cin7's own /Product resource silently omits certain nested arrays
// (BOM/Suppliers/ReorderLevels) unless an explicit Include*=true flag is
// passed — confirmed live elsewhere in this codebase (see products.ts).
// Worth testing the same pattern here: maybe /production/order's Operations
// omit per-operation progress (Start/Suspend/Resume/Complete state, actual
// vs planned time) unless a similar flag is set, rather than that data not
// existing at all — Cin7's own UI clearly tracks it (Operation start/
// completion date, Actual Time, a Start/Suspend/Resume/Complete lifecycle
// per operation, confirmed live 2026-07-14 against MO-00019: Mixing shown
// complete, Blending shown not-yet-started).
const OPERATION_STATUS_FLAG_CANDIDATES = [
  "IncludeOperationStatus",
  "IncludeActuals",
  "IncludeActualTime",
  "IncludeTaskDetails",
  "IncludeOperationDetails",
  "IncludeProgress",
];

// Separately, maybe operation-level state lives on its own addressable
// resource rather than as extra fields on /production/order — same probing
// approach as probeWorkCentrePaths, keyed by one real OperationID from the
// order (Cin7's UI's Start/Suspend/Resume/Complete buttons must read/write
// state somewhere).
const OPERATION_PATH_CANDIDATES = ["/production/operation", "/production/order/operation", "/production/orderOperation", "/production/task"];

/**
 * Advanced Manufacturing anticipation work (new client, 2026-07-14),
 * continued from surveyProductionOrderRoutingTasks: that probe ruled out the
 * Type "R" routing rows as a source of per-operation progress (they just
 * mirror the parent order's own Status, and there's only one "R" row for a
 * 2-operation order). This probe tests two remaining hypotheses instead —
 * an omitted-by-default Include* flag on /production/order, or a wholly
 * separate operation-level resource — against a real order with one
 * genuinely completed and one genuinely not-yet-started operation.
 */
export async function surveyProductionOrderOperationStatus(creds: Cin7Credentials, orderNumber: string): Promise<ProductionOrderOperationStatusSurvey> {
  try {
    const orders = await fetchAllProductionOrdersList(creds);
    const match = orders.find((o) => o.Type === "O" && (o.OrderNumber ?? "").toUpperCase() === orderNumber.toUpperCase());
    if (!match?.ProductionOrderID) {
      return {
        orderNumber,
        found: false,
        probes: [],
        error: "No matching Manufacture Order (Type \"O\") found in this instance's production order list",
      };
    }
    const productionOrderId = match.ProductionOrderID;

    const baseline = await cin7Request<{ ProductionOrders?: Record<string, unknown>[] }>(creds, "/production/order", {
      query: { ProductionOrderID: productionOrderId, ReturnAttachmentsContent: "false" },
    });
    const baselineOperations = Array.isArray(baseline.ProductionOrders?.[0]?.Operations)
      ? (baseline.ProductionOrders![0].Operations as Record<string, unknown>[])
      : [];
    const operationSummaries = baselineOperations.map((op) => ({ operationId: String(op.OperationID ?? ""), name: String(op.Name ?? "") }));
    const baselineKeys = baselineOperations.map((op) => Object.keys(op).sort());

    const probes: ProductionOrderOperationProbe[] = [];

    for (const flag of OPERATION_STATUS_FLAG_CANDIDATES) {
      const attempt = `GET /production/order?...&${flag}=true`;
      try {
        const response = await cin7Request<{ ProductionOrders?: Record<string, unknown>[] }>(creds, "/production/order", {
          query: { ProductionOrderID: productionOrderId, ReturnAttachmentsContent: "false", [flag]: "true" },
        });
        const ops = Array.isArray(response.ProductionOrders?.[0]?.Operations) ? (response.ProductionOrders![0].Operations as Record<string, unknown>[]) : [];
        const keys = ops.map((op) => Object.keys(op).sort());
        const changed = JSON.stringify(keys) !== JSON.stringify(baselineKeys);
        probes.push({ attempt, status: 200, looksLikeJson: true, operationKeys: keys, snippet: changed ? "KEYS CHANGED vs baseline" : "same keys as baseline (flag had no effect)" });
      } catch (e) {
        probes.push({ attempt, status: 0, looksLikeJson: false, error: e instanceof Error ? e.message : "error" });
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }

    const sampleOperationId = operationSummaries[0]?.operationId;
    if (sampleOperationId) {
      for (const path of OPERATION_PATH_CANDIDATES) {
        const attempt = `GET ${path}?OperationID=...`;
        const url = new URL(`${creds.baseUrl.replace(/\/$/, "")}${path}`);
        url.searchParams.set("OperationID", sampleOperationId);
        url.searchParams.set("ProductionOrderID", productionOrderId);
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
          probes.push({ attempt, status: response.status, looksLikeJson, snippet: text.slice(0, 300) });
        } catch (e) {
          probes.push({ attempt, status: 0, looksLikeJson: false, error: e instanceof Error ? e.message : "network error" });
        }
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
    }

    return { orderNumber, found: true, productionOrderId, operations: operationSummaries, probes };
  } catch (e) {
    return { orderNumber, found: false, probes: [], error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ProductionRunSurvey {
  orderNumber: string;
  found: boolean;
  productionOrderId?: string;
  raw?: unknown;
  error?: string;
}

/**
 * Advanced Manufacturing anticipation work (new client), continued —
 * neither /production/order nor its Type "R" routing-list siblings expose
 * per-operation progress (see surveyProductionOrderRoutingTasks and
 * surveyProductionOrderOperationStatus above). Found via the community
 * Apiary spec transcription (nnhansg/dear-openapi,
 * specification/dearinventory.apib, ~line 10660 "Production Run"): a wholly
 * separate resource, GET /production/order/run?ProductionOrderID=X, is
 * documented with exactly the missing fields — Run-level Status
 * (PLANNED/IN PROGRESS/OPERATION_COMPLETED/COMPLETED/VOIDED), a WIPAccount
 * field, and per-Operation Status (PLANNED/IN PROGRESS/SUSPENDED/COMPLETED)
 * with real StartDate/EndDate/ActualTime plus actual (not just planned)
 * Component quantities/wastage and Resource costs — and PUT
 * .../run/operation/{start,suspend,resume,complete} matching the exact
 * button set seen live in Cin7's own UI for this order. Not yet confirmed
 * live on this account — community docs aren't guaranteed current, so this
 * probes the real endpoint and returns the raw response rather than
 * assuming the spec is accurate.
 */
export async function surveyProductionRun(creds: Cin7Credentials, orderNumber: string): Promise<ProductionRunSurvey> {
  try {
    const orders = await fetchAllProductionOrdersList(creds);
    const match = orders.find((o) => o.Type === "O" && (o.OrderNumber ?? "").toUpperCase() === orderNumber.toUpperCase());
    if (!match?.ProductionOrderID) {
      return {
        orderNumber,
        found: false,
        error: "No matching Manufacture Order (Type \"O\") found in this instance's production order list",
      };
    }

    const raw = await cin7Request<unknown>(creds, "/production/order/run", {
      query: { ProductionOrderID: match.ProductionOrderID },
    });
    return { orderNumber, found: true, productionOrderId: match.ProductionOrderID, raw };
  } catch (e) {
    return { orderNumber, found: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ProductionOrderStatusSurvey {
  totalOrders: number;
  /** Distinct Status values (Type "O" rows only) with counts — the field this codebase already stores as production_orders.list_status. */
  statusCounts: { value: string; count: number }[];
  /** Distinct OrderStatus values with counts — NOT currently stored anywhere; only ever seen "RELEASED" live so far (both MO-00036 and MO-00019). This survey exists to confirm whether DRAFT/PLANNED/etc are real values on this account before building a Kanban column around them. */
  orderStatusCounts: { value: string; count: number }[];
}

/**
 * Advanced Manufacturing anticipation work, continued (2026-07-14): the
 * client wants a Kanban board grouped by pre-production status
 * ("draft/planned/released"), which sounds like Cin7's `OrderStatus`
 * field on /production/orderList — but every real order checked so far
 * has shown `OrderStatus: "RELEASED"`, even a fully completed one. Rather
 * than guess DRAFT/PLANNED are real values here, this tallies every Type
 * "O" order's real Status and OrderStatus across the whole account.
 */
export async function surveyProductionOrderStatuses(creds: Cin7Credentials): Promise<ProductionOrderStatusSurvey> {
  const orders = await fetchAllProductionOrdersList(creds);
  const typeO = orders.filter((o) => o.Type === "O");

  function tally(values: (string | undefined)[]): { value: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const v of values) {
      const key = v ?? "(none)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }

  return {
    totalOrders: typeO.length,
    statusCounts: tally(typeO.map((o) => o.Status)),
    orderStatusCounts: tally(typeO.map((o) => o.OrderStatus)),
  };
}

export interface PurchaseDetailCheck {
  orderNumber: string;
  purchaseId: string;
  combinedReceivingStatus?: string;
  /** Which endpoint actually served this purchase — see the function comment for why both exist. */
  source?: "purchase" | "advanced-purchase";
  orderLineCount: number;
  stockReceivedLineCount: number;
  error?: string;
}

export interface PurchaseDetailSurvey {
  probed: number;
  checks: PurchaseDetailCheck[];
  orderLineKeys: string[];
  orderLineKeyExamples: Record<string, unknown>;
  stockReceivedLineKeys: string[];
  stockReceivedLineKeyExamples: Record<string, unknown>;
  /** The first successfully-probed "classic" /purchase response, for close inspection beyond the aggregated key survey above. */
  rawExample?: unknown;
  /** The first successfully-probed /advanced-purchase response — a genuinely different shape (StockReceived is an array of receipt events, each with its own Lines[], not one object), worth inspecting separately. */
  rawExampleAdvanced?: unknown;
}

/** Extracts every StockReceived line regardless of which shape served it: classic /purchase has one `{Lines: [...]}` object, /advanced-purchase has an array of receipt events each with their own `Lines[]`. */
function extractStockReceivedLines(stockReceived: unknown): Record<string, unknown>[] {
  if (Array.isArray(stockReceived)) {
    return stockReceived.flatMap((receipt) =>
      receipt && Array.isArray((receipt as Record<string, unknown>).Lines) ? ((receipt as Record<string, unknown>).Lines as Record<string, unknown>[]) : []
    );
  }
  const lines = (stockReceived as Record<string, unknown> | undefined)?.Lines;
  return Array.isArray(lines) ? (lines as Record<string, unknown>[]) : [];
}

/**
 * Diagnostic only: /purchaseList (already synced for status/dates via
 * fetchAllPurchasesList) has no line-item quantities at all — the "in" side
 * of a planned Inventory Movement report needs the detail endpoint's actual
 * receiving events. Confirmed via FalconEyeSolutions/CIN7-DearInventory's
 * generated client that GET /purchase?ID=<id> has BOTH Order.Lines[]
 * (ordered qty) and a separate StockReceived.Lines[] (actual received qty +
 * its own Date per line, distinct from the PO's single OrderDate) —
 * StockReceived is what a real movement report should use, mirroring how
 * Assembly's PickLines (actual) differ from OrderLines (planned).
 *
 * Confirmed live 2026-07-09: the plain /purchase endpoint rejects "Advanced
 * Purchase"/"Service Purchase" orders with a 400 ("...Please use
 * AdvancedPurchase endpoint") — 3 of the first 5 real purchases on this
 * account were this type, so it's not a rare edge case. Falls back to
 * GET /advanced-purchase?ID=<id> (same ID/CombineAdditionalCharges params,
 * confirmed via the same community client) when that specific error occurs.
 */
export async function surveyPurchaseDetailFields(creds: Cin7Credentials, maxToProbe = 5): Promise<PurchaseDetailSurvey> {
  const purchases = await fetchAllPurchasesList(creds);
  const candidates = purchases.filter((p) => p.CombinedReceivingStatus && p.CombinedReceivingStatus !== "NOT RECEIVED").slice(0, maxToProbe);

  const orderLineKeySet = new Set<string>();
  const orderLineKeyExamples: Record<string, unknown> = {};
  const stockReceivedLineKeySet = new Set<string>();
  const stockReceivedLineKeyExamples: Record<string, unknown> = {};
  const checks: PurchaseDetailCheck[] = [];
  let rawExample: unknown;
  let rawExampleAdvanced: unknown;

  for (const purchase of candidates) {
    let source: "purchase" | "advanced-purchase" = "purchase";
    try {
      let response: Record<string, unknown>;
      try {
        response = await cin7Request<Record<string, unknown>>(creds, "/purchase", {
          query: { ID: purchase.ID, CombineAdditionalCharges: "false" },
        });
      } catch (e) {
        const isAdvancedPurchaseOnly = e instanceof Cin7ApiError && /Advanced Purchase/i.test(e.message);
        if (!isAdvancedPurchaseOnly) throw e;
        source = "advanced-purchase";
        response = await cin7Request<Record<string, unknown>>(creds, "/advanced-purchase", {
          query: { ID: purchase.ID, CombineAdditionalCharges: "false" },
        });
      }

      const order = response.Order as Record<string, unknown> | undefined;
      const orderLines = Array.isArray(order?.Lines) ? (order.Lines as Record<string, unknown>[]) : [];
      collectKeys(orderLines, orderLineKeySet, orderLineKeyExamples);

      const stockReceivedLines = extractStockReceivedLines(response.StockReceived);
      collectKeys(stockReceivedLines, stockReceivedLineKeySet, stockReceivedLineKeyExamples);

      if (source === "purchase" && rawExample === undefined) rawExample = response;
      if (source === "advanced-purchase" && rawExampleAdvanced === undefined) rawExampleAdvanced = response;

      checks.push({
        orderNumber: purchase.OrderNumber ?? purchase.ID,
        purchaseId: purchase.ID,
        combinedReceivingStatus: purchase.CombinedReceivingStatus,
        source,
        orderLineCount: orderLines.length,
        stockReceivedLineCount: stockReceivedLines.length,
      });
    } catch (e) {
      checks.push({
        orderNumber: purchase.OrderNumber ?? purchase.ID,
        purchaseId: purchase.ID,
        combinedReceivingStatus: purchase.CombinedReceivingStatus,
        orderLineCount: 0,
        stockReceivedLineCount: 0,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return {
    probed: checks.length,
    checks,
    orderLineKeys: [...orderLineKeySet].sort(),
    orderLineKeyExamples,
    stockReceivedLineKeys: [...stockReceivedLineKeySet].sort(),
    stockReceivedLineKeyExamples,
    rawExample,
    rawExampleAdvanced,
  };
}

export interface ProductAvailabilitySurvey {
  probed: number;
  /** Whichever top-level response key actually held the record array — not assumed, since this endpoint has never been called live before. */
  listKey: string | null;
  keys: string[];
  keyExamples: Record<string, unknown>;
  rawResponseKeys: string[];
  rawExample?: unknown;
  /**
   * All rows for the first SKU that appears more than once among the probed
   * records (different Location/Bin/Batch) — settles whether `OnHand` is the
   * real per-row quantity and `StockOnHand` a repeated per-SKU rollup, or the
   * other way round. Confirmed live 2026-07-09 that the two fields carry
   * very different magnitudes for the same row (OnHand=2 vs StockOnHand=660)
   * with no spec explanation of which is which — summing the wrong one
   * across a product's multiple location rows would badly over- or
   * under-count total stock, so this can't be guessed.
   */
  multiRowSkuExample?: { sku: string; rows: Record<string, unknown>[] };
}

/**
 * Diagnostic only: /ref/productavailability has never been called live in
 * this codebase — the community spec (github.com/nnhansg/dear-openapi)
 * documents fields (OnHand/Available/Allocated/OnOrder/StockOnHand/
 * InTransit/NextDeliveryDate/StockValue/Location/Bin/Batch/ExpiryDate) but
 * its sample response body is truncated before showing the actual list
 * array's key name, and this project has repeatedly found the community
 * spec wrong about real API shapes (Purchases' PutAway vs StockReceived,
 * Work Centres being unreachable entirely) — so this doesn't assume a key
 * name, it discovers whichever top-level property in the real response
 * actually holds an array of records. Also deliberately does NOT filter to
 * non-zero quantities, to confirm whether a fully-stocked-out product still
 * appears in the list at all (the Stock Health report's stockout-detection
 * design depends on the answer).
 *
 * Confirmed live 2026-07-09: `StockValue` and `Category` (assumed from the
 * spec) do NOT actually appear on this account's real response at all —
 * dropped from the planned schema. `keys` is the authoritative field list,
 * not the spec's.
 */
export async function surveyProductAvailabilityFields(creds: Cin7Credentials, limit = 200): Promise<ProductAvailabilitySurvey> {
  const response = await cin7Request<Record<string, unknown>>(creds, "/ref/productavailability", {
    query: { Page: 1, Limit: limit },
  });

  const rawResponseKeys = Object.keys(response);
  let listKey: string | null = null;
  let records: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(response)) {
    if (Array.isArray(value)) {
      listKey = key;
      records = value as Record<string, unknown>[];
      break;
    }
  }

  const keySet = new Set<string>();
  const keyExamples: Record<string, unknown> = {};
  collectKeys(records, keySet, keyExamples);

  const rowsBySku = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const sku = typeof record.SKU === "string" ? record.SKU : undefined;
    if (!sku) continue;
    const existing = rowsBySku.get(sku);
    if (existing) existing.push(record);
    else rowsBySku.set(sku, [record]);
  }
  const multiSkuEntry = [...rowsBySku.entries()].find(([, rows]) => rows.length > 1);

  return {
    probed: records.length,
    listKey,
    keys: [...keySet].sort(),
    keyExamples,
    rawResponseKeys,
    rawExample: records[0],
    multiRowSkuExample: multiSkuEntry ? { sku: multiSkuEntry[0], rows: multiSkuEntry[1] } : undefined,
  };
}

export interface SaleFulfillmentDetailCheck {
  saleId: string;
  orderNumber?: string;
  hasOrder: boolean;
  orderLineCount: number;
  fulfilmentCount: number;
  error?: string;
}

export interface SaleFulfillmentSurvey {
  probed: number;
  /** Every key seen on real /saleList entries — confirms whether CombinedPickingStatus/CombinedPackingStatus/CombinedShippingStatus/CombinedPaymentStatus/Carrier/CombinedTrackingNumbers (documented in the community spec, never fetched by this codebase) actually exist. */
  listKeys: string[];
  listKeyExamples: Record<string, unknown>;
  detailChecks: SaleFulfillmentDetailCheck[];
  orderLineKeys: string[];
  orderLineKeyExamples: Record<string, unknown>;
  fulfilmentKeys: string[];
  fulfilmentKeyExamples: Record<string, unknown>;
  pickPackShipLineKeys: string[];
  pickPackShipLineKeyExamples: Record<string, unknown>;
  /** The first probed detail response that actually had a non-empty Fulfilments[] — most useful for close inspection since it exercises the Pick/Pack/Ship nesting, not just Order. */
  rawDetailExample?: unknown;
}

/**
 * Diagnostic only, blocking Step 0 for the Order Fulfillment Dashboard —
 * neither `Order`/`Fulfilments[]` on GET /sale, nor CombinedPickingStatus/
 * CombinedPackingStatus/CombinedShippingStatus/CombinedPaymentStatus/
 * Carrier/CombinedTrackingNumbers on /saleList have ever been fetched by
 * this codebase. The community spec documents all of them, but this
 * project has repeatedly found that spec wrong or incomplete (Purchases'
 * StockReceived/PutAway split, Product Availability's StockValue/Category
 * not existing at all and StockOnHand meaning something completely
 * different from its name) — including CombinedInvoiceStatus specifically,
 * whose real live values already turned out to differ from the spec's
 * claimed set (2026-07-06). Samples evenly across the full sale list
 * (not just the most recent page) for variety across different lifecycle
 * stages, rather than assuming the first few rows are representative.
 */
export async function surveySaleFulfillmentFields(creds: Cin7Credentials, maxToProbe = 10): Promise<SaleFulfillmentSurvey> {
  const listResponse = await cin7Request<{ SaleList?: Record<string, unknown>[] }>(creds, "/saleList", { query: { Page: 1, Limit: 100 } });
  const listEntries = listResponse.SaleList ?? [];

  const listKeySet = new Set<string>();
  const listKeyExamples: Record<string, unknown> = {};
  collectKeys(listEntries, listKeySet, listKeyExamples);

  const step = Math.max(1, Math.floor(listEntries.length / maxToProbe));
  const candidates = listEntries.filter((_, i) => i % step === 0).slice(0, maxToProbe);

  const orderLineKeySet = new Set<string>();
  const orderLineKeyExamples: Record<string, unknown> = {};
  const fulfilmentKeySet = new Set<string>();
  const fulfilmentKeyExamples: Record<string, unknown> = {};
  const pickPackShipLineKeySet = new Set<string>();
  const pickPackShipLineKeyExamples: Record<string, unknown> = {};
  const detailChecks: SaleFulfillmentDetailCheck[] = [];
  let rawDetailExample: unknown;

  for (const entry of candidates) {
    const saleId = entry.SaleID as string | undefined;
    const orderNumber = entry.OrderNumber as string | undefined;
    if (!saleId) continue;

    try {
      const detail = await cin7Request<Record<string, unknown>>(creds, "/sale", { query: { ID: saleId } });

      const order = detail.Order as Record<string, unknown> | undefined;
      const orderLines = Array.isArray(order?.Lines) ? (order!.Lines as Record<string, unknown>[]) : [];
      collectKeys(orderLines, orderLineKeySet, orderLineKeyExamples);

      const fulfilments = Array.isArray(detail.Fulfilments) ? (detail.Fulfilments as Record<string, unknown>[]) : [];
      collectKeys(fulfilments, fulfilmentKeySet, fulfilmentKeyExamples);

      for (const fulfilment of fulfilments) {
        for (const stage of ["Pick", "Pack", "Ship"] as const) {
          const stageObj = fulfilment[stage] as Record<string, unknown> | undefined;
          const lines = Array.isArray(stageObj?.Lines) ? (stageObj!.Lines as Record<string, unknown>[]) : [];
          collectKeys(lines, pickPackShipLineKeySet, pickPackShipLineKeyExamples);
        }
      }

      if (rawDetailExample === undefined && fulfilments.length) rawDetailExample = detail;

      detailChecks.push({ saleId, orderNumber, hasOrder: Boolean(order), orderLineCount: orderLines.length, fulfilmentCount: fulfilments.length });
    } catch (e) {
      detailChecks.push({ saleId, orderNumber, hasOrder: false, orderLineCount: 0, fulfilmentCount: 0, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return {
    probed: detailChecks.length,
    listKeys: [...listKeySet].sort(),
    listKeyExamples,
    detailChecks,
    orderLineKeys: [...orderLineKeySet].sort(),
    orderLineKeyExamples,
    fulfilmentKeys: [...fulfilmentKeySet].sort(),
    fulfilmentKeyExamples,
    pickPackShipLineKeys: [...pickPackShipLineKeySet].sort(),
    pickPackShipLineKeyExamples,
    rawDetailExample,
  };
}

export interface BackorderEtaCheck {
  orderNumber: string;
  purchaseId: string;
  combinedReceivingStatus?: string;
  /** The order-level ETA already synced via fetchAllPurchasesList — captured here for side-by-side comparison against whatever (if anything) turns up per-line below. */
  requiredBy?: string | null;
  source?: "purchase" | "advanced-purchase";
  orderLineCount: number;
  error?: string;
}

export interface BackorderEtaSurvey {
  probed: number;
  checks: BackorderEtaCheck[];
  orderLineKeys: string[];
  orderLineKeyExamples: Record<string, unknown>;
  /** The first probed response from a genuinely NOT RECEIVED order (zero received so far) — the one case surveyPurchaseDetailFields never checked, since it filtered those out (nothing to see in StockReceived there). A fully open PO is exactly what a backorder-ETA feature needs to reference for a still-fully-outstanding line, so it's worth confirming the response shape holds up here too rather than assuming it generalizes from partially-received orders. */
  rawExampleNotReceived?: unknown;
}

/**
 * Diagnostic only. The open question for a possible "backorder ETA"
 * dashboard feature (surface which open purchase order a backordered sale
 * line's stock is expected on, and when): does GET /purchase (or
 * /advanced-purchase)'s Order.Lines[] carry any PER-LINE expected-date
 * field, or is `RequiredBy` (already synced at the purchase-order level via
 * fetchAllPurchasesList) the only ETA Cin7 exposes at all? If it's
 * order-level only, every SKU on that PO simply shares one ETA — not
 * actually a blocker, just a coarser feature than a per-line date would
 * allow. surveyPurchaseDetailFields already confirmed Order.Lines[] exists
 * with SKU/Quantity, but only checked partially/fully-received orders
 * (irrelevant to StockReceived's own survey); this specifically probes
 * NOT RECEIVED / PARTIALLY RECEIVED orders instead, and reports the
 * order-level RequiredBy alongside each check for direct comparison.
 */
export async function surveyBackorderEtaFields(creds: Cin7Credentials, maxToProbe = 8): Promise<BackorderEtaSurvey> {
  const purchases = await fetchAllPurchasesList(creds);
  const candidates = purchases
    .filter((p) => p.CombinedReceivingStatus === "NOT RECEIVED" || p.CombinedReceivingStatus === "PARTIALLY RECEIVED")
    .slice(0, maxToProbe);

  const orderLineKeySet = new Set<string>();
  const orderLineKeyExamples: Record<string, unknown> = {};
  const checks: BackorderEtaCheck[] = [];
  let rawExampleNotReceived: unknown;

  for (const purchase of candidates) {
    let source: "purchase" | "advanced-purchase" = "purchase";
    try {
      let response: Record<string, unknown>;
      try {
        response = await cin7Request<Record<string, unknown>>(creds, "/purchase", {
          query: { ID: purchase.ID, CombineAdditionalCharges: "false" },
        });
      } catch (e) {
        const isAdvancedPurchaseOnly = e instanceof Cin7ApiError && /Advanced Purchase/i.test(e.message);
        if (!isAdvancedPurchaseOnly) throw e;
        source = "advanced-purchase";
        response = await cin7Request<Record<string, unknown>>(creds, "/advanced-purchase", {
          query: { ID: purchase.ID, CombineAdditionalCharges: "false" },
        });
      }

      const order = response.Order as Record<string, unknown> | undefined;
      const orderLines = Array.isArray(order?.Lines) ? (order.Lines as Record<string, unknown>[]) : [];
      collectKeys(orderLines, orderLineKeySet, orderLineKeyExamples);

      if (rawExampleNotReceived === undefined && purchase.CombinedReceivingStatus === "NOT RECEIVED") rawExampleNotReceived = response;

      checks.push({
        orderNumber: purchase.OrderNumber ?? purchase.ID,
        purchaseId: purchase.ID,
        combinedReceivingStatus: purchase.CombinedReceivingStatus,
        requiredBy: purchase.RequiredBy,
        source,
        orderLineCount: orderLines.length,
      });
    } catch (e) {
      checks.push({
        orderNumber: purchase.OrderNumber ?? purchase.ID,
        purchaseId: purchase.ID,
        combinedReceivingStatus: purchase.CombinedReceivingStatus,
        requiredBy: purchase.RequiredBy,
        orderLineCount: 0,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return {
    probed: checks.length,
    checks,
    orderLineKeys: [...orderLineKeySet].sort(),
    orderLineKeyExamples,
    rawExampleNotReceived,
  };
}

export interface SaleShipByWriteTest {
  saleId: string;
  orderNumber: string;
  shipByTested: string | null;
  putSucceeded: boolean;
  putError?: string;
  /** Fields that differ between the before/after GET, other than ones Cin7 stamps on any write (LastModifiedOn) — a non-empty list here means the round-trip write isn't safe to trust for a real ShipBy change yet. */
  unexpectedChanges: { field: string; before: unknown; after: unknown }[];
}

/** Cin7 stamps this on every write regardless of what changed — its presence here isn't a sign the round-trip corrupted anything. */
const SALE_FIELDS_EXPECTED_TO_CHANGE_ON_ANY_WRITE = new Set(["LastModifiedOn"]);

/**
 * Diagnostic only, blocking Step 0 for the shipping calendar's
 * drag-to-reschedule feature. Finds a real sale by its Order Number (e.g.
 * "SO-00583" — safer for Anton to target a known test order by than an
 * internal Sale GUID), performs a genuine no-op `PUT /sale` round-trip via
 * updateSaleShipBy (writes back the sale's own current ShipBy, unchanged),
 * then diffs a fresh GET against the original. This confirms both that Cin7
 * actually accepts the write AND that nothing else on the sale silently
 * changed as a side effect, before trusting this mechanism for a real
 * drag-triggered date change.
 */
export async function testSaleShipByWriteBack(creds: Cin7Credentials, orderNumber: string): Promise<SaleShipByWriteTest> {
  const listResponse = await cin7Request<{ SaleList?: Record<string, unknown>[] }>(creds, "/saleList", {
    query: { Page: 1, Limit: 5, Search: orderNumber },
  });
  const match = (listResponse.SaleList ?? []).find((entry) => entry.OrderNumber === orderNumber);
  if (!match?.SaleID) throw new Error(`No sale found with Order Number "${orderNumber}"`);
  const saleId = match.SaleID as string;

  const before = await cin7Request<Record<string, unknown>>(creds, "/sale", { query: { ID: saleId } });
  const shipByTested = (before.ShipBy as string | null) ?? null;

  try {
    await updateSaleShipBy(creds, saleId, shipByTested);
  } catch (e) {
    return {
      saleId,
      orderNumber,
      shipByTested,
      putSucceeded: false,
      putError: e instanceof Cin7ApiError ? `[${e.status}] ${e.message}` : e instanceof Error ? e.message : "Unknown error",
      unexpectedChanges: [],
    };
  }

  const after = await cin7Request<Record<string, unknown>>(creds, "/sale", { query: { ID: saleId } });

  const unexpectedChanges: { field: string; before: unknown; after: unknown }[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SALE_FIELDS_EXPECTED_TO_CHANGE_ON_ANY_WRITE.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      unexpectedChanges.push({ field: key, before: before[key], after: after[key] });
    }
  }

  return { saleId, orderNumber, shipByTested, putSucceeded: true, unexpectedChanges };
}

export interface ProductSupplierLinkTest {
  sku: string;
  supplierName: string;
  supplierFound: boolean;
  supplierId?: string;
  /** Whether the product's own GET /Product?ID= response actually carried its ID field — ruling out "the product's own ID is what's missing" before blaming the nested Suppliers shape. */
  fullRecordHadId: boolean;
  /** Tried in order, stopping at the first success. */
  attempts: { shape: string; succeeded: boolean; error?: string }[];
}

/**
 * Diagnostic only. Confirmed live 2026-07-11 (Casa das Natas): pushProduct's
 * Suppliers array (products.ts, sent as `{ SupplierName,
 * SupplierInventoryCode, SupplierProductName, FixedCost }` per the community
 * client spec's worked example, no ID field at all) is rejected with
 * "Suppliers is invalid" — across many different supplier names, including
 * ones already confirmed to exist as real Cin7 supplier records, so it isn't
 * a per-row name-matching issue. A first live test adding `SupplierID`
 * changed the error to "Required attribute 'ID' not provided" rather than
 * fixing it — i.e. still wrong, but differently wrong, suggesting the
 * correct field name/shape isn't settled yet. Rather than guess again one
 * round-trip at a time, this tries a few candidate shapes in sequence
 * (stopping at the first that succeeds) so one click converges on the
 * answer instead of three.
 *
 * Each attempt PUTs the product's own current full record (not a
 * reconstructed payload — same safety reasoning as testSaleShipByWriteBack,
 * a real PUT needs the product's actual current data) with only Suppliers
 * changed, and the top-level `ID` set explicitly (not just trusted to
 * survive the `...full` spread) to also rule out the top-level product ID
 * itself being what "Required attribute 'ID' not provided" referred to.
 * Safe to do since the product currently has no working supplier link at
 * all (this exact push already fails today) — not a case of overwriting a
 * working one.
 */
export async function testProductSupplierLink(creds: Cin7Credentials, sku: string, supplierName: string): Promise<ProductSupplierLinkTest> {
  const supplierRes = await cin7Request<{ SupplierList?: Record<string, unknown>[] }>(creds, "/supplier", {
    query: { Name: supplierName, page: 1, limit: 1 },
  });
  const supplier = supplierRes.SupplierList?.find((s) => s.Name === supplierName);
  const supplierId = supplier?.ID as string | undefined;

  const listRes = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
    query: { SKU: sku, page: 1, limit: 1 },
  });
  const match = listRes.Products?.find((p) => p.SKU === sku);
  if (!match?.ID) throw new Error(`No product found with SKU "${sku}"`);
  const productId = match.ID as string;
  const full = await cin7Request<Record<string, unknown>>(creds, "/Product", { query: { ID: productId } });
  const fullRecordHadId = Boolean(full.ID);

  const candidates: { shape: string; suppliers: Record<string, unknown>[] }[] = [
    { shape: "ID + SupplierName", suppliers: [{ ID: supplierId, SupplierName: supplierName }] },
    { shape: "ID only", suppliers: [{ ID: supplierId }] },
    { shape: "SupplierID + ID + SupplierName (both id fields)", suppliers: [{ ID: supplierId, SupplierID: supplierId, SupplierName: supplierName }] },
  ];

  const attempts: { shape: string; succeeded: boolean; error?: string }[] = [];
  for (const candidate of candidates) {
    try {
      await cin7Request(creds, "/Product", {
        method: "PUT",
        body: { ...full, ID: productId, Suppliers: candidate.suppliers },
      });
      attempts.push({ shape: candidate.shape, succeeded: true });
      return { sku, supplierName, supplierFound: Boolean(supplier), supplierId, fullRecordHadId, attempts };
    } catch (e) {
      attempts.push({
        shape: candidate.shape,
        succeeded: false,
        error: e instanceof Cin7ApiError ? `[${e.status}] ${e.message}` : e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
  return { sku, supplierName, supplierFound: Boolean(supplier), supplierId, fullRecordHadId, attempts };
}
