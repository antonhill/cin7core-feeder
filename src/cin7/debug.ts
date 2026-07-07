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
