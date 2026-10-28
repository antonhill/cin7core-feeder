import "server-only";
import { Cin7ApiError, cin7Request } from "@/cin7/http";
import { findProductBySku } from "@/cin7/products";
import { findCustomerByName } from "@/cin7/customers";
import { fetchAllSalesList, fetchSaleDetail } from "@/cin7/sales";
import type { Cin7Credentials } from "@/cin7/types";

// CREATES A CIN7 ADVANCED SALE for a NewQuip billing project, in two non-idempotent POSTs (docs/projects-poc/integration-decisions.md §3):
//   1. POST /sale        header: customer, location, SaleType "Advanced", our stable ExternalID.
//   2. POST /sale/order  the ORDER: physical product lines at R0, and the approved CONTRACT VALUE as Additional Charges (VAT as a monetary
//                        amount per charge, never a rate - the INV-00021 lesson), Status AUTHORISED.
//
// !! API CONTRACT STATUS: UNVERIFIED. The two-step header+lines shape and ExternalID are the proven quote-creation pattern
// (sale-quote-write.ts, live 2026-08-26). `SaleType: "Advanced"`, SkipQuote:true, POST /sale/order, and an AdditionalCharges-bearing
// order with R0 lines are NOT yet proven. Every assumption below is verified by the caller's read-back (it refuses to link a Sale that
// does not read back exactly as planned) and must be proven on a disposable Sale before any real use. This module is only ever called
// behind the server-side write flag by src/lib/projects/cin7-sale-creation-store.ts.

export interface AdvancedSaleHeader {
  /** Cin7 customer NAME (the API references customers by name). */
  customer: string;
  location: string;
  saleOrderDate: string; // YYYY-MM-DD
  taxRule: string;
  /** Stable reconciliation key; also searched for by reconciliation. */
  externalId: string;
  note?: string | null;
}
export interface AdvancedSaleLine { productId: string; sku: string; name: string; quantity: number; taxRule: string }
export interface AdvancedSaleCharge { description: string; priceExVat: number; taxAmount: number; taxRule: string; account: string }

export function buildAdvancedSaleHeaderBody(h: AdvancedSaleHeader): Record<string, unknown> {
  return {
    Customer: h.customer,
    Location: h.location,
    SaleOrderDate: h.saleOrderDate,
    SaleType: "Advanced",
    SkipQuote: true,
    TaxInclusive: false,
    TaxRule: h.taxRule,
    ExternalID: h.externalId,
    ...(h.note ? { Note: h.note } : {}),
  };
}

/** The POST /sale/order body (pure). Throws on any non-finite or invalid money/quantity so nothing malformed is ever sent. */
export function buildAdvancedSaleOrderBody(saleId: string, lines: AdvancedSaleLine[], charges: AdvancedSaleCharge[]): Record<string, unknown> {
  if (charges.length === 0) throw new Error("An Advanced Sale needs at least one contract charge.");
  for (const l of lines) {
    if (!l.productId || !l.sku) throw new Error("Every physical line needs its Cin7 ProductID and SKU.");
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new Error(`Quantity for ${l.sku} must be a positive, finite number.`);
  }
  for (const c of charges) {
    if (!Number.isFinite(c.priceExVat) || c.priceExVat <= 0) throw new Error("A contract charge must be a positive, finite amount.");
    if (!Number.isFinite(c.taxAmount) || c.taxAmount < 0) throw new Error("Contract charge VAT must be a non-negative, finite amount.");
  }
  return {
    SaleID: saleId,
    CombineAdditionalCharges: false,
    Status: "AUTHORISED",
    Lines: lines.map((l) => ({ ProductID: l.productId, SKU: l.sku, Name: l.name, Quantity: l.quantity, Price: 0, Discount: 0, Tax: 0, TaxRule: l.taxRule, Total: 0 })),
    AdditionalCharges: charges.map((c) => ({
      Description: c.description, Comment: "", Quantity: 1, Price: c.priceExVat, Discount: 0, Tax: c.taxAmount, TaxRule: c.taxRule, Total: c.priceExVat, Account: c.account,
    })),
  };
}

export type CreateSaleOutcome =
  /** Both steps answered successfully. The caller still verifies by reading the Sale back. */
  | { kind: "created"; saleId: string; saleNumber: string | null }
  /** The header was definitively rejected (4xx). Nothing exists in Cin7. */
  | { kind: "rejected"; httpStatus: number; message: string }
  /** The header exists (or may exist) but the order was not completed / its outcome is unknown. Never auto-resumed. */
  | { kind: "uncertain"; reason: string; saleId: string | null; saleNumber: string | null; stage: "HEADER_UNKNOWN" | "HEADER_CREATED" };

interface SaleCreateResponse { ID?: string; Order?: { SaleOrderNumber?: string } }

/** Resolves ProductIDs by SKU (read-only). Returns the missing SKUs instead of throwing so the caller can report all of them. */
export async function resolveProductIds(creds: Cin7Credentials, skus: string[]): Promise<{ ids: Map<string, string>; missing: string[] }> {
  const ids = new Map<string, string>();
  const missing: string[] = [];
  for (const sku of [...new Set(skus)]) {
    const f = await findProductBySku(creds, sku);
    if (f) ids.set(sku, f.id); else missing.push(sku);
  }
  return { ids, missing };
}

/** Whether a customer of exactly this NAME exists (read-only). */
export async function customerExists(creds: Cin7Credentials, name: string): Promise<boolean> {
  return (await findCustomerByName(creds, name)) !== null;
}

/** Sends the two creates ONCE each (nonIdempotentCreate: no automatic resend) and classifies the result. Never throws for a Cin7 outcome. */
export async function createAdvancedSale(creds: Cin7Credentials, header: AdvancedSaleHeader, lines: AdvancedSaleLine[], charges: AdvancedSaleCharge[]): Promise<CreateSaleOutcome> {
  let orderBody: Record<string, unknown>;
  let headerBody: Record<string, unknown>;
  try {
    headerBody = buildAdvancedSaleHeaderBody(header);
    orderBody = buildAdvancedSaleOrderBody("00000000-0000-0000-0000-000000000000", lines, charges); // validate BEFORE anything is sent
  } catch (e) {
    return { kind: "rejected", httpStatus: 0, message: e instanceof Error ? e.message : "Invalid sale request" };
  }
  let saleId: string;
  let saleNumber: string | null;
  try {
    const sale = await cin7Request<SaleCreateResponse>(creds, "/sale", { method: "POST", nonIdempotentCreate: true, body: headerBody });
    if (!sale.ID) return { kind: "uncertain", reason: "Cin7 answered the header request without a Sale ID.", saleId: null, saleNumber: null, stage: "HEADER_UNKNOWN" };
    saleId = sale.ID;
    saleNumber = sale.Order?.SaleOrderNumber ?? null;
  } catch (e) {
    if (e instanceof Cin7ApiError) {
      if (e.ambiguous) return { kind: "uncertain", reason: "The connection failed after the header request was sent.", saleId: null, saleNumber: null, stage: "HEADER_UNKNOWN" };
      if (e.status >= 400 && e.status < 500 && e.status !== 429) return { kind: "rejected", httpStatus: e.status, message: e.message };
      return { kind: "uncertain", reason: `Cin7 answered HTTP ${e.status} to the header request; a Sale may or may not exist.`, saleId: null, saleNumber: null, stage: "HEADER_UNKNOWN" };
    }
    return { kind: "uncertain", reason: "Unexpected error while creating the Sale header.", saleId: null, saleNumber: null, stage: "HEADER_UNKNOWN" };
  }
  try {
    await cin7Request<unknown>(creds, "/sale/order", { method: "POST", nonIdempotentCreate: true, body: { ...orderBody, SaleID: saleId } });
    return { kind: "created", saleId, saleNumber };
  } catch (e) {
    const why = e instanceof Cin7ApiError ? `Cin7 answered ${e.ambiguous ? "with a dropped connection" : `HTTP ${e.status}`} to the order request` : "Unexpected error while adding the order";
    return { kind: "uncertain", reason: `${why}; the Sale header ${saleNumber ?? saleId} exists but may be incomplete. Complete or void it in Cin7, or link it.`, saleId, saleNumber, stage: "HEADER_CREATED" };
  }
}

/** Reconciliation lookup: the Sale carrying our exact ExternalID, or null. Bounded by `sinceIso`; a miss is not proof outside that window. */
export async function findSaleByExternalIdForCustomer(creds: Cin7Credentials, customer: string, externalId: string, sinceIso: string): Promise<{ saleId: string; saleNumber: string | null }[]> {
  const list = await fetchAllSalesList(creds, sinceIso);
  const out: { saleId: string; saleNumber: string | null }[] = [];
  for (const s of list.filter((x) => x.Customer === customer)) {
    if (!s.SaleID) continue;
    const d = await fetchSaleDetail(creds, s.SaleID);
    if (d.ExternalID === externalId) out.push({ saleId: d.ID, saleNumber: d.Order?.SaleOrderNumber ?? null });
  }
  return out;
}
