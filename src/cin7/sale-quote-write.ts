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
  return body;
}

/**
 * The POST /sale/quote body (pure). `Total` is the net (ex-tax, ex-discount) line total and `Tax`
 * is the computed tax amount — Cin7 uses the Tax we send rather than deriving it from TaxRule, so we
 * must compute it. In tax-inclusive mode the line's Price already includes tax, so net is the
 * tax-stripped amount; otherwise net is the discounted price and tax is added on top.
 */
export function buildQuoteBody(
  saleId: string,
  lines: SaleQuoteLineInput[],
  productIdBySku: Map<string, string>,
  taxInclusive = false,
): Record<string, unknown> {
  return {
    SaleID: saleId,
    Memo: null,
    Status: "DRAFT",
    Lines: lines.map((l) => {
      const discounted = l.unitPrice * l.quantity * (1 - l.discountPct / 100);
      const rate = l.taxRatePct / 100;
      const net = taxInclusive && rate > -1 ? discounted / (1 + rate) : discounted;
      const tax = taxInclusive ? discounted - net : net * rate;
      return {
        ProductID: productIdBySku.get(l.productSku) ?? undefined,
        SKU: l.productSku,
        Name: l.productName,
        Quantity: l.quantity,
        Price: l.unitPrice,
        Discount: l.discountPct,
        Tax: round2(tax),
        TaxRule: l.taxRule,
        Total: round2(net),
      };
    }),
    AdditionalCharges: [],
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
      body: buildQuoteBody(saleId, lines, productIdBySku, header.taxInclusive),
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
