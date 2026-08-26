import "server-only";
import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request, Cin7ApiError } from "@/cin7/http";
import { findProductBySku } from "@/cin7/products";
import { fetchAllSalesList } from "@/cin7/sales";
import { round2 } from "@/lib/quote-margin";

// The Cin7 Sale/Quote CREATE contract, confirmed live 2026-08-26 against the Spark Demo sandbox
// (probe --create, 200/200). Two steps, both non-idempotent creates, all references by NAME:
//   1. POST /sale        → creates the sale header (Status "ESTIMATING"), returns ID + SO number.
//   2. POST /sale/quote  → adds the quote lines, returns Cin7's authoritative totals.
// TaxRule is required on the header AND each line. ExternalID is our reconciliation key.

export interface SaleQuoteHeaderInput {
  customer: string;
  location: string;
  saleOrderDate: string; // YYYY-MM-DD
  taxInclusive: boolean;
  taxRule: string;
  priceTier?: string | null;
  salesRep?: string | null;
  externalId: string;
  /** The Sale's internal Note (not customer-facing) — we write the estimated margin summary here. */
  note?: string | null;
}

export interface SaleQuoteLineInput {
  productSku: string;
  productName: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRule: string;
  /** The TaxRule's rate as a percent (e.g. 15). Cin7 USES the Tax amount we send on the line rather
   * than recomputing from TaxRule, so we compute it — a 0 here is why VAT came through as 0 before. */
  taxRatePct: number;
}

/** A create failure tagged with which step failed, whether the outcome is ambiguous, and (for a
 * step-2 failure) the sale id that WAS created — so the caller can settle/reconcile correctly. */
export class SaleQuoteCreateError extends Error {
  constructor(
    public stage: "header" | "lines",
    public ambiguous: boolean,
    message: string,
    public saleId?: string,
    public quoteNumber?: string | null,
  ) {
    super(message);
    this.name = "SaleQuoteCreateError";
  }
}

/** The POST /sale header body (pure). */
export function buildSaleHeaderBody(h: SaleQuoteHeaderInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    Customer: h.customer,
    Location: h.location,
    SaleOrderDate: h.saleOrderDate,
    SkipQuote: false, // keep the sale at the Quote stage
    TaxInclusive: h.taxInclusive,
    TaxRule: h.taxRule,
    ExternalID: h.externalId,
  };
  if (h.priceTier) body.PriceTier = h.priceTier;
  if (h.salesRep) body.SalesRepresentative = h.salesRep;
  if (h.note) body.Note = h.note;
  return body;
}

/** An additional charge/service line (no product) — Description instead of a SKU. */
export interface SaleQuoteChargeInput {
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRule: string;
  taxRatePct: number;
}

export interface BuildQuoteOptions {
  taxInclusive?: boolean;
  /** Revenue GL account additional charges post to (the customer's). Omitted if unknown. */
  revenueAccount?: string | null;
}

/** The line/charge `Total` and `Tax` Cin7 expects. `Total` is the discounted line amount IN THE
 * QUOTE'S TAX MODE — net when tax-exclusive, GROSS (tax-inclusive) when tax-inclusive (confirmed
 * live 2026-08-26: Cin7 rejects a net Total in inclusive mode, "Expected value is: <gross>"). `Tax`
 * is the tax portion — Cin7 uses the value we send rather than deriving it from TaxRule. */
function lineTotals(unitPrice: number, quantity: number, discountPct: number, taxRatePct: number, taxInclusive: boolean) {
  const total = unitPrice * quantity * (1 - discountPct / 100);
  const rate = taxRatePct / 100;
  const tax = taxInclusive && rate > -1 ? total - total / (1 + rate) : total * rate;
  return { total: round2(total), tax: round2(tax) };
}

/** The POST /sale/quote body (pure). Product lines → Lines[]; charge lines → AdditionalCharges[]
 * (shape confirmed live 2026-08-26). */
export function buildQuoteBody(
  saleId: string,
  lines: SaleQuoteLineInput[],
  charges: SaleQuoteChargeInput[],
  productIdBySku: Map<string, string>,
  opts: BuildQuoteOptions = {},
): Record<string, unknown> {
  const taxInclusive = opts.taxInclusive === true;
  return {
    SaleID: saleId,
    Memo: null,
    Status: "DRAFT",
    Lines: lines.map((l) => {
      const { total, tax } = lineTotals(l.unitPrice, l.quantity, l.discountPct, l.taxRatePct, taxInclusive);
      return {
        ProductID: productIdBySku.get(l.productSku) ?? undefined,
        SKU: l.productSku,
        Name: l.productName,
        Quantity: l.quantity,
        Price: l.unitPrice,
        Discount: l.discountPct,
        Tax: tax,
        TaxRule: l.taxRule,
        Total: total,
      };
    }),
    AdditionalCharges: charges.map((c) => {
      const { total, tax } = lineTotals(c.unitPrice, c.quantity, c.discountPct, c.taxRatePct, taxInclusive);
      return {
        Description: c.description,
        Comment: "",
        Quantity: c.quantity,
        Price: c.unitPrice,
        Discount: c.discountPct,
        Tax: tax,
        TaxRule: c.taxRule,
        Total: total,
        ...(opts.revenueAccount ? { Account: opts.revenueAccount } : {}),
      };
    }),
  };
}

interface SaleCreateResponse {
  ID?: string;
  Order?: { SaleOrderNumber?: string };
}
interface QuoteCreateResponse {
  TotalBeforeTax?: number;
  Tax?: number;
  Total?: number;
}

export interface CreateSaleQuoteResult {
  saleId: string;
  quoteNumber: string | null;
  totals: { totalBeforeTax: number; tax: number; total: number };
}

/**
 * Create a Cin7 quote from our quote data — resolve each product's Cin7 ProductID by SKU (the line
 * model wants it), POST the header, then POST the quote lines. Throws {@link SaleQuoteCreateError}
 * tagged with the failing stage + ambiguity so the caller drives idempotency/reconciliation.
 */
export async function createSaleQuote(
  creds: Cin7Credentials,
  header: SaleQuoteHeaderInput,
  lines: SaleQuoteLineInput[],
  charges: SaleQuoteChargeInput[] = [],
  revenueAccount: string | null = null,
): Promise<CreateSaleQuoteResult> {
  // Resolve ProductIDs by SKU (one live lookup per distinct SKU). A missing product is a definite,
  // pre-create failure — nothing has been created yet, so it's safe to surface and retry.
  const productIdBySku = new Map<string, string>();
  for (const sku of [...new Set(lines.map((l) => l.productSku))]) {
    const found = await findProductBySku(creds, sku);
    if (!found) throw new SaleQuoteCreateError("header", false, `Product "${sku}" was not found in this Cin7 instance.`);
    productIdBySku.set(sku, found.id);
  }

  // Step 1: create the sale header.
  let saleId: string;
  let quoteNumber: string | null;
  try {
    const sale = await cin7Request<SaleCreateResponse>(creds, "/sale", {
      method: "POST",
      nonIdempotentCreate: true,
      body: buildSaleHeaderBody(header),
    });
    if (!sale.ID) throw new Error("Cin7 /sale returned no ID.");
    saleId = sale.ID;
    quoteNumber = sale.Order?.SaleOrderNumber ?? null;
  } catch (e) {
    const ambiguous = e instanceof Cin7ApiError && e.ambiguous;
    throw new SaleQuoteCreateError("header", ambiguous, e instanceof Error ? e.message : String(e));
  }

  // Step 2: add the quote lines. A failure here leaves an orphan header — carry saleId on the error.
  try {
    const quote = await cin7Request<QuoteCreateResponse>(creds, "/sale/quote", {
      method: "POST",
      nonIdempotentCreate: true,
      body: buildQuoteBody(saleId, lines, charges, productIdBySku, { taxInclusive: header.taxInclusive, revenueAccount }),
    });
    return {
      saleId,
      quoteNumber,
      totals: {
        totalBeforeTax: Number(quote.TotalBeforeTax ?? 0),
        tax: Number(quote.Tax ?? 0),
        total: Number(quote.Total ?? 0),
      },
    };
  } catch (e) {
    const ambiguous = e instanceof Cin7ApiError && e.ambiguous;
    throw new SaleQuoteCreateError("lines", ambiguous, e instanceof Error ? e.message : String(e), saleId, quoteNumber);
  }
}

/**
 * Reconcile an ambiguous create: find the sale we (maybe) created by its ExternalID. Lists sales
 * updated since `sinceIso` (bounded to at most the claim TTL ago), narrows by customer name, then
 * confirms the exact ExternalID via a detail fetch — an EXACT match on our own key, not a heuristic.
 * Returns null if no sale carries our ExternalID (so it was not created; safe to retry fresh).
 */
export async function findSaleByExternalId(
  creds: Cin7Credentials,
  customerName: string,
  externalId: string,
  sinceIso: string,
): Promise<{ saleId: string; quoteNumber: string | null } | null> {
  const list = await fetchAllSalesList(creds, sinceIso);
  const candidates = list.filter((s) => s.Customer === customerName);
  for (const s of candidates) {
    if (!s.SaleID) continue;
    const detail = await cin7Request<{ ID?: string; ExternalID?: string; Order?: { SaleOrderNumber?: string } }>(creds, "/sale", {
      query: { ID: s.SaleID },
    });
    if (detail.ExternalID === externalId && detail.ID) {
      return { saleId: detail.ID, quoteNumber: detail.Order?.SaleOrderNumber ?? null };
    }
  }
  return null;
}
