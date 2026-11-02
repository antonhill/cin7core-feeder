// UAT-028: a read-only comparison of the invoice statuses Toolbox RECORDED (when it created or reconciled each posting) with what ONE read of the Cin7 Sale says NOW.
// Pure and Cin7-free: it takes the postings and the already-read Sale. It never changes a posting, never decides a status from the Toolbox record, and a status is only ever
// reported as "current" when it came from that Sale read. A posting whose invoice is not on the Sale is reported, never "repaired".
import type { Cin7SaleView, PostingRow } from "./cin7-posting-store";
import type { ReadInvoice } from "./cin7-posting";

export type VerifyOutcome =
  | "SAME"              // Cin7 reports the same status that was recorded
  | "CHANGED"           // Cin7 reports a different status (e.g. recorded Draft, now Authorised)
  | "NOT_IN_SALE"       // no invoice with this number on the Sale: it may have been voided or removed in Cin7
  | "IDENTITY_MISMATCH" // the number matches but the Cin7 task id differs from the one recorded: not trusted
  | "STATUS_UNREADABLE"; // the invoice is there but Cin7 gave no status

export interface VerifiedInvoice {
  postingId: string; claimId: string; invoiceNumber: string;
  recordedStatus: string | null; currentStatus: string | null; outcome: VerifyOutcome;
}
export interface InvoiceVerification {
  verifiedAt: string; saleId: string; saleNumber: string | null;
  invoices: VerifiedInvoice[];
  /** Invoices on the Sale that no Toolbox posting accounts for (for example one raised by hand in Cin7). Information only. */
  unaccounted: Array<{ invoiceNumber: string | null; status: string | null }>;
}

const norm = (s: string | null | undefined): string | null => { const t = (s ?? "").trim().toUpperCase(); return t === "" ? null : t; };
/** Only a posting that actually produced an invoice can be checked. */
const checkable = (p: PostingRow) => (p.posting_state === "CREATED" || p.posting_state === "RECONCILED") && !!(p.cin7_invoice_number ?? "").trim();

export function verifyInvoiceStatuses(input: { saleId: string; postings: ReadonlyArray<PostingRow>; sale: Cin7SaleView; now: Date }): InvoiceVerification {
  const { saleId, postings, sale, now } = input;
  if (sale.id !== saleId) throw new Error("Cin7 returned a different Sale than the one linked to this project; nothing was verified.");
  const used = new Set<ReadInvoice>();
  const invoices: VerifiedInvoice[] = [];
  for (const p of postings.filter(checkable)) {
    const number = (p.cin7_invoice_number ?? "").trim();
    const found = sale.invoices.filter((i) => (i.invoiceNumber ?? "").trim() === number);
    const recorded = norm(p.cin7_status);
    const base = { postingId: p.id, claimId: p.claim_id, invoiceNumber: number, recordedStatus: recorded };
    if (found.length !== 1) { invoices.push({ ...base, currentStatus: null, outcome: "NOT_IN_SALE" }); continue; } // none, or ambiguous: never guessed
    const inv = found[0];
    used.add(inv);
    if (p.cin7_task_id && inv.taskId && p.cin7_task_id !== inv.taskId) { invoices.push({ ...base, currentStatus: norm(inv.status), outcome: "IDENTITY_MISMATCH" }); continue; }
    const current = norm(inv.status);
    invoices.push({ ...base, currentStatus: current, outcome: current === null ? "STATUS_UNREADABLE" : current === recorded ? "SAME" : "CHANGED" });
  }
  return {
    verifiedAt: now.toISOString(), saleId, saleNumber: sale.saleNumber,
    invoices,
    unaccounted: sale.invoices.filter((i) => !used.has(i)).map((i) => ({ invoiceNumber: i.invoiceNumber, status: norm(i.status) })),
  };
}

/** Human wording for a Cin7 invoice status. Unknown values are shown as Cin7 gave them (title-cased), never mapped to something friendlier. */
export function statusLabel(s: string | null): string {
  if (s === null) return "Not read";
  const t = s.toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
