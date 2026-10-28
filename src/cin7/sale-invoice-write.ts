import "server-only";
import { Cin7ApiError, cin7Request } from "@/cin7/http";
import type { Cin7Credentials } from "@/cin7/types";

// CREATES A COMMERCIAL PROGRESS INVOICE on an EXISTING Cin7 Advanced Sale (POST /sale/invoice) — the representation proven by hand
// on a disposable sale (docs/projects-poc/P5-design-multi-invoice-write.md): the commercial amount carried in AdditionalCharges, a
// stable Memo, DRAFT status. Three patterns (docs/projects-poc/integration-decisions.md §5): deposit-only and commercial-only invoices
// send NO product Lines; a progress invoice WITH physical products also sends the selected SKUs at R0 (price, tax and total zero), so
// the physical quantity is invoiced without adding revenue. It generates no inventory fulfilment, stock movement or COGS.
// The R0 line shape follows the quote writer's line fields; its acceptance by POST /sale/invoice is UNVERIFIED until a disposable
// API proof (needs an owner GO).
//
// This module only BUILDS the request and CLASSIFIES the outcome. It decides nothing about WHETHER to post: eligibility, the feature
// flag, idempotency and the state machine all live in the caller (src/lib/projects/cin7-posting-store.ts).

export const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

export interface ProgressInvoiceCharge {
  description: string;
  /** Ex-VAT amount, in rands. */
  priceExVat: number;
  /**
   * The VAT as a MONETARY AMOUNT in rands for this charge (e.g. 75000 for R500,000 at 15%) - NOT a percentage. Cin7 uses the Tax value it is
   * sent and does not derive it from TaxRule (src/cin7/sale-quote-write.ts, confirmed live 2026-08-26). The P5 fixture (R100 at 15%) could
   * not tell a rate from an amount - both were 15 - which is how a rate was sent as R15 of VAT on a R500,000 charge.
   */
  taxAmount: number;
  comment?: string;
}

/** A physical product line invoiced at R0. Identity comes from the Sale's own order line; nothing here prices it. */
export interface ProgressInvoiceLine {
  productId: string;
  sku: string;
  name: string;
  /** Units invoiced on THIS invoice (already validated against the Sale's remaining invoiceable quantity by the caller). */
  quantity: number;
}

export interface ProgressInvoiceInput {
  saleId: string;
  /** Stable, searchable reconciliation reference. */
  memo: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  invoiceDueDate: string;
  /** Tax rule name and revenue account, both taken from the linked Sale / supplied explicitly — never guessed here. */
  taxRule: string;
  account: string;
  charges: ProgressInvoiceCharge[];
  /** Optional physical products, always sent at R0. Omit for deposit-only and commercial-only invoices. */
  lines?: ProgressInvoiceLine[];
}

/** The exact request body. Pure. `Lines` is empty unless physical products were selected, and then every line is R0. */
export function buildProgressInvoiceBody(i: ProgressInvoiceInput): Record<string, unknown> {
  if (i.charges.length === 0) throw new Error("A progress invoice needs at least one commercial charge.");
  const lines = i.lines ?? [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new Error(`Invoice quantity for ${l.sku} must be a positive, finite number.`);
    if (!l.productId || !l.sku) throw new Error("An invoice product line needs the Cin7 ProductID and SKU.");
    if (seen.has(l.sku)) throw new Error(`SKU ${l.sku} appears twice on the invoice; combine the quantities.`);
    seen.add(l.sku);
  }
  // Never send a non-finite or negative money value. These would be silently accepted or turned into NaN further down.
  for (const c of i.charges) {
    if (!Number.isFinite(c.priceExVat) || c.priceExVat <= 0) throw new Error("Invoice charge amount must be a positive, finite number.");
    if (!Number.isFinite(c.taxAmount) || c.taxAmount < 0) throw new Error("Invoice charge VAT must be a non-negative, finite amount.");
  }
  return {
    SaleID: i.saleId,
    TaskID: ZERO_GUID,
    CombineAdditionalCharges: false,
    Memo: i.memo,
    Status: "DRAFT",
    InvoiceDate: i.invoiceDate,
    InvoiceDueDate: i.invoiceDueDate,
    Lines: lines.map((l) => ({
      ProductID: l.productId, SKU: l.sku, Name: l.name, Quantity: l.quantity,
      Price: 0, Discount: 0, Tax: 0, TaxRule: i.taxRule, Total: 0,
    })),
    AdditionalCharges: i.charges.map((c) => ({
      Description: c.description,
      Quantity: 1,
      Price: c.priceExVat,
      Discount: 0,
      Tax: c.taxAmount,
      // Cin7 validates Total against Quantity x Price: NET, tax not added in (observed 2026-10-16, attempt 1 -> HTTP 400).
      Total: c.priceExVat,
      TaxRule: i.taxRule,
      Account: i.account,
      ...(c.comment ? { Comment: c.comment } : {}),
    })),
  };
}

export type CreateInvoiceOutcome =
  /** Cin7 returned positive evidence: an invoice carrying OUR memo. */
  /**
   * `totalBeforeTax` / `tax` / `total` are what Cin7 echoed in the POST response, or null when it did not (or sent something that is not a
   * finite number). NEVER NaN: the caller must verify missing amounts by reading the Sale back.
   */
  | { kind: "created"; invoiceNumber: string; taskId: string; status: string; totalBeforeTax: number | null; tax: number | null; total: number | null }
  /** Cin7 definitively rejected the request (4xx): nothing was created. */
  | { kind: "rejected"; httpStatus: number; message: string }
  /** The outcome is unknown (timeout, dropped connection, 5xx, or a 200 without our memo). NEVER retry blindly. */
  | { kind: "uncertain"; reason: string };

interface InvoiceResponse {
  SaleID?: string;
  Invoices?: Array<{ InvoiceNumber?: string; TaskID?: string; Memo?: string; Status?: string; TotalBeforeTax?: number; Tax?: number; Total?: number }>;
}

const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Sends the request ONCE (nonIdempotentCreate: no automatic resend) and classifies the result. Never throws for a Cin7 outcome. */
export async function createSaleProgressInvoice(creds: Cin7Credentials, input: ProgressInvoiceInput): Promise<CreateInvoiceOutcome> {
  try {
    const res = await cin7Request<InvoiceResponse>(creds, "/sale/invoice", {
      method: "POST",
      nonIdempotentCreate: true,
      body: buildProgressInvoiceBody(input),
    });
    const mine = (res.Invoices ?? []).filter((inv) => inv.Memo === input.memo);
    if (mine.length !== 1 || !mine[0].InvoiceNumber || !mine[0].TaskID) {
      return { kind: "uncertain", reason: `Cin7 answered 200 but returned ${mine.length} invoice(s) carrying the memo; creation is not proven.` };
    }
    const inv = mine[0];
    return {
      kind: "created",
      invoiceNumber: inv.InvoiceNumber!,
      taskId: inv.TaskID!,
      status: inv.Status ?? "UNKNOWN",
      totalBeforeTax: finiteOrNull(inv.TotalBeforeTax),
      tax: finiteOrNull(inv.Tax),
      total: finiteOrNull(inv.Total),
    };
  } catch (e) {
    if (e instanceof Cin7ApiError) {
      if (e.ambiguous) return { kind: "uncertain", reason: "The connection failed after the request was sent." };
      if (e.status >= 400 && e.status < 500 && e.status !== 429) return { kind: "rejected", httpStatus: e.status, message: e.message };
      return { kind: "uncertain", reason: `Cin7 answered HTTP ${e.status}; creation may or may not have happened.` };
    }
    return { kind: "uncertain", reason: "Unexpected error while calling Cin7." };
  }
}
