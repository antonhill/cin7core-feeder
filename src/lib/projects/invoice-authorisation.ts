// UX-006g1: invoice status TRUTH. Pure and presentation-only: no Cin7 read, no store, no action. Three concepts that must never be conflated:
//   A. Toolbox posting / reconciliation  - "Posted as INV-n · Reconciled <time>" (the Toolbox record).
//   B. Cin7 invoice authorisation        - the latest VERIFIED status (UAT-028, a manual read-only Sale read) with its time; otherwise only the RECORDED snapshot, labelled as
//                                          such with its time and never styled as current. cin7_status is written once at post / reconcile time and never refreshed.
//   C. Customer payment                  - "not known to Toolbox"; never inferred.
import { formatSast } from "@/lib/approvals/time";
import type { ClaimCin7Status } from "./claim-cin7-status";
import { statusLabel, type VerifiedInvoice, type VerifyOutcome } from "./invoice-verification";

export type AuthState = "NO_INVOICE" | "VERIFIED" | "NOT_VERIFIED" | "VERIFY_FAILED" | "NOT_IN_SALE" | "AMBIGUOUS" | "IDENTITY_MISMATCH" | "STATUS_UNREADABLE";
export type AuthTone = "neutral" | "info" | "warning" | "success" | "danger";

/** Per-invoice problem outcomes keep their UAT-028 wording. */
export const OUTCOME_TEXT: Record<VerifyOutcome, { tone: AuthTone; text: string }> = {
  SAME: { tone: "success", text: "Matches" },
  CHANGED: { tone: "warning", text: "Changed in Cin7" },
  NOT_IN_SALE: { tone: "danger", text: "Not found on the Sale" },
  AMBIGUOUS: { tone: "danger", text: "More than one invoice with this number" },
  IDENTITY_MISMATCH: { tone: "danger", text: "Different Cin7 invoice" },
  STATUS_UNREADABLE: { tone: "warning", text: "Status not given" },
};

/** What a verification says about one posting: `invoice` is undefined when the read did not list it. Absent = nothing verified (or the verification is stale). */
export interface VerifiedRef { verifiedAt: string; invoice: VerifiedInvoice | undefined }

export interface InvoiceAuthorisation {
  /** A: the Toolbox record. */
  posting: { text: string; tone: AuthTone };
  /** B: the Cin7 authorisation. `text` is the one line to show; `tone` is success ONLY for a verified AUTHORISED invoice. */
  state: AuthState;
  tone: AuthTone;
  text: string;
  /** A short label for a status chip (the chip never wraps; `text` carries the time and wraps). */
  chip: string;
  /** The verified status (uppercase) and time; null unless state is VERIFIED. */
  verifiedStatus: string | null;
  verifiedAt: string | null;
  /** The older snapshot. `historical` = a verification disagrees with it, so it must be shown as superseded, not current. */
  recorded: { status: string | null; at: string | null; text: string; historical: boolean } | null;
  /** The last verification attempt failed (even if an older verification is still shown). */
  readFailed: boolean;
  /** C: never inferred. */
  payment: string;
}

export const PAYMENT_TEXT = "Payment: not known to Toolbox";
const when = (iso: string | null) => (iso ? ` at ${formatSast(iso)}` : "");

function postingLine(r: ClaimCin7Status): { text: string; tone: AuthTone } {
  const inv = r.invoiceNumber;
  switch (r.kind) {
    case "NOT_POSTED": return { text: "Not posted to Cin7", tone: "neutral" };
    case "POSTING": return { text: "Posting to Cin7", tone: "warning" };
    case "UNCERTAIN": return { text: r.label, tone: r.tone };
    case "FAILED": return { text: "Not created in Cin7 - can be retried", tone: "danger" };
    default:
      return r.reconciled
        ? { text: `Posted as ${inv ?? "an invoice"} · Reconciled ${formatSast(r.reconciledAt)}`, tone: "neutral" }
        : { text: `Posted as ${inv ?? "an invoice"} · not yet reconciled`, tone: "warning" };
  }
}

/**
 * `verified` = the CURRENT verification for this posting (the caller passes nothing when there is none, or when it is stale). `readFailed` = the last Verify attempt failed.
 * A failed read never erases recorded evidence and never claims success; an older successful verification stays visible (with its own time).
 */
export function invoiceAuthorisation(recorded: ClaimCin7Status, verified?: VerifiedRef | null, readFailed = false): InvoiceAuthorisation {
  const posting = postingLine(recorded);
  const base = { posting, payment: PAYMENT_TEXT, readFailed, verifiedStatus: null, verifiedAt: null };
  const hasInvoice = !!recorded.invoiceNumber && (recorded.kind === "DRAFT_CREATED" || recorded.kind === "AUTHORISED" || recorded.kind === "CREATED_OTHER");
  if (!hasInvoice) return { ...base, state: "NO_INVOICE", tone: posting.tone, text: posting.text, chip: recorded.label, recorded: null };

  const rs = recorded.recordedStatus;
  const recText = rs ? `Recorded: ${rs.toLowerCase()}${when(recorded.recordedAt)} (not verified)` : "Recorded: no status";
  const rec = { status: rs, at: recorded.recordedAt, text: recText, historical: false };

  const v = verified?.invoice;
  if (verified && v) {
    if (v.outcome === "SAME" || v.outcome === "CHANGED") {
      if (v.currentStatus) {
        const cur = v.currentStatus;
        const differs = v.outcome === "CHANGED";
        return {
          ...base, state: "VERIFIED", verifiedStatus: cur, verifiedAt: verified.verifiedAt,
          tone: cur === "AUTHORISED" || cur === "AUTHORIZED" ? "success" : cur === "DRAFT" ? "info" : "neutral",
          text: `${statusLabel(cur)} in Cin7 - verified ${formatSast(verified.verifiedAt)}`, chip: `${statusLabel(cur)} (verified)`,
          recorded: differs ? { status: rs, at: recorded.recordedAt, text: `Earlier record (superseded): ${rs ? rs.toLowerCase() : "no status"}${when(recorded.recordedAt)}`, historical: true } : null,
        };
      }
    } else {
      // NOT_IN_SALE / AMBIGUOUS / IDENTITY_MISMATCH / STATUS_UNREADABLE: the existing wording; the recorded snapshot stays as historical evidence.
      return { ...base, state: v.outcome, tone: OUTCOME_TEXT[v.outcome].tone, text: `${OUTCOME_TEXT[v.outcome].text} (checked ${formatSast(verified.verifiedAt)})`, chip: OUTCOME_TEXT[v.outcome].text, recorded: { ...rec, text: `Last recorded: ${rs ? rs.toLowerCase() : "no status"}${when(recorded.recordedAt)}`, historical: true } };
    }
  }
  if (readFailed) {
    return { ...base, state: "VERIFY_FAILED", tone: "warning", chip: "Could not verify", text: `Could not verify - Cin7 read failed; last recorded: ${rs ?? "no status"}${when(recorded.recordedAt)}`, recorded: { ...rec, text: `Last recorded: ${rs ? rs.toLowerCase() : "no status"}${when(recorded.recordedAt)}` } };
  }
  // Nothing verified: the snapshot is evidence of the past, never a current status. A snapshot AUTHORISED reads as a record; a DRAFT must never look finished.
  const auth = rs === "AUTHORISED" || rs === "AUTHORIZED";
  return {
    ...base, state: "NOT_VERIFIED", tone: auth ? "neutral" : "warning", chip: rs ? `${statusLabel(rs)} recorded (not verified)` : "Not currently verified",
    text: auth ? recText : rs ? `Not currently verified - last recorded: ${rs}${when(recorded.recordedAt)}` : "Not currently verified - no status recorded",
    recorded: rec,
  };
}

/** Identity of the postings a verification described. A verification is only current while this is unchanged (a reconcile or a new invoice changes it). */
export function postingsSignature(rows: ReadonlyArray<{ claim_id: string; posting_state: string; cin7_status: string | null; cin7_invoice_number: string | null; completed_at?: string | null; reconciled_at: string | null }>): string {
  return [...rows].sort((a, b) => a.claim_id.localeCompare(b.claim_id)).map((p) => (
    // Only a posting that produced an invoice has evidence that can change under a verification; the others are identified by their state.
    p.posting_state === "CREATED" || p.posting_state === "RECONCILED"
      ? `${p.claim_id}:${p.posting_state}:${(p.cin7_status ?? "").trim().toUpperCase()}:${(p.cin7_invoice_number ?? "").trim()}:${p.completed_at ?? ""}:${p.reconciled_at ?? ""}`
      : `${p.claim_id}:${p.posting_state}`
  )).join("|");
}
/** The same signature, from what the project view already carries (claims with a posting). */
export function viewPostingsSignature(claims: ReadonlyArray<{ id: string; cin7Status: ClaimCin7Status }>): string {
  return postingsSignature(claims.filter((c) => c.cin7Status.postingState !== null).map((c) => ({
    claim_id: c.id, posting_state: c.cin7Status.postingState!, cin7_status: c.cin7Status.recordedStatus, cin7_invoice_number: c.cin7Status.invoiceNumber, completed_at: c.cin7Status.completedAt, reconciled_at: c.cin7Status.reconciledAt,
  })));
}
