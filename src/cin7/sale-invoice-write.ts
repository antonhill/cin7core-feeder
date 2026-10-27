import "server-only";
import { Cin7ApiError, cin7Request } from "@/cin7/http";
import type { Cin7Credentials } from "@/cin7/types";

// CREATES A COMMERCIAL PROGRESS INVOICE on an EXISTING Cin7 Advanced Sale (POST /sale/invoice) — the representation proven by hand
// on a disposable sale (docs/projects-poc/P5-design-multi-invoice-write.md): no stock Lines, the commercial amount carried in
// AdditionalCharges, a stable Memo, DRAFT status. It generates no inventory fulfilment, stock movement or COGS.
//
// This module only BUILDS the request and CLASSIFIES the outcome. It decides nothing about WHETHER to post: eligibility, the feature
// flag, idempotency and the state machine all live in the caller (src/lib/projects/cin7-posting-store.ts).

export const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

export interface ProgressInvoiceCharge {
  description: string;
  /** Ex-VAT amount, in rands. */
  priceExVat: number;
  taxRatePct: number;
  comment?: string;
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
}

/** The exact request body. Pure. `Lines` is ALWAYS empty: a progress invoice never touches stock. */
export function buildProgressInvoiceBody(i: ProgressInvoiceInput): Record<string, unknown> {
  return {
    SaleID: i.saleId,
    TaskID: ZERO_GUID,
    CombineAdditionalCharges: false,
    Memo: i.memo,
    Status: "DRAFT",
    InvoiceDate: i.invoiceDate,
    InvoiceDueDate: i.invoiceDueDate,
    Lines: [],
    AdditionalCharges: i.charges.map((c) => ({
      Description: c.description,
      Quantity: 1,
      Price: c.priceExVat,
      Discount: 0,
      Tax: c.taxRatePct,
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
  | { kind: "created"; invoiceNumber: string; taskId: string; status: string; totalBeforeTax: number; tax: number; total: number }
  /** Cin7 definitively rejected the request (4xx): nothing was created. */
  | { kind: "rejected"; httpStatus: number; message: string }
  /** The outcome is unknown (timeout, dropped connection, 5xx, or a 200 without our memo). NEVER retry blindly. */
  | { kind: "uncertain"; reason: string };

interface InvoiceResponse {
  SaleID?: string;
  Invoices?: Array<{ InvoiceNumber?: string; TaskID?: string; Memo?: string; Status?: string; TotalBeforeTax?: number; Tax?: number; Total?: number }>;
}

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
      totalBeforeTax: Number(inv.TotalBeforeTax ?? NaN),
      tax: Number(inv.Tax ?? NaN),
      total: Number(inv.Total ?? NaN),
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
