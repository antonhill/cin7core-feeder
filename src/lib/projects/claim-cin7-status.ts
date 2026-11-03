// How a claim's Cin7 position is DISPLAYED. The authoritative source is project_claim_cin7_postings (one row per claim, written by the posting
// flow); the older project_cin7_links table is never written by it. A claim with no posting row is "Not posted"; nothing else is. This is a
// display classifier only - it never decides whether a posting may be (re)tried.

import { isStalePending } from "./posting-staleness";

export interface ClaimPostingRow {
  claim_id: string;
  posting_state: string;
  cin7_invoice_number: string | null;
  cin7_status: string | null;
  reconciled_at: string | null;
  last_error_message?: string | null;
  /** AMOUNT_MISMATCH is kept on a CREATED row when reconciliation found the invoice differs from the approved claim. */
  last_error_code?: string | null;
  requested_at?: string | null;
}

export type ClaimCin7Kind = "NOT_POSTED" | "POSTING" | "DRAFT_CREATED" | "AUTHORISED" | "CREATED_OTHER" | "FAILED" | "UNCERTAIN";
export interface ClaimCin7Status {
  kind: ClaimCin7Kind;
  label: string;
  tone: "neutral" | "info" | "warning" | "success" | "danger";
  invoiceNumber: string | null;
  reconciled: boolean;
  detail: string | null;
  /** The raw posting_state (null = no posting row). Additive facts for the commercial billing derivation; they never change the label above. */
  postingState: string | null;
  /** CREATED invoice whose last reconciliation recorded AMOUNT_MISMATCH. */
  mismatch: boolean;
  /** A PENDING posting older than the stale window (or with no readable request time): its outcome is unknown. */
  stalePending: boolean;
  reconciledAt: string | null;
}

/** The additive posting facts for a row (never inferred from the claim's own status, which stays APPROVED after posting). */
function postingFacts(p: ClaimPostingRow | null | undefined, now: number): Pick<ClaimCin7Status, "postingState" | "mismatch" | "stalePending" | "reconciledAt"> {
  if (!p) return { postingState: null, mismatch: false, stalePending: false, reconciledAt: null };
  const readable = !!p.requested_at && Number.isFinite(Date.parse(p.requested_at));
  return {
    postingState: p.posting_state,
    mismatch: p.posting_state === "CREATED" && p.last_error_code === "AMOUNT_MISMATCH",
    stalePending: p.posting_state === "PENDING" && (!readable || isStalePending(p.requested_at as string, now)),
    reconciledAt: p.reconciled_at ?? null,
  };
}

export function claimCin7Status(p: ClaimPostingRow | null | undefined, now: number = Date.now()): ClaimCin7Status {
  return { ...displayStatus(p), ...postingFacts(p, now) };
}

function displayStatus(p: ClaimPostingRow | null | undefined): Omit<ClaimCin7Status, "postingState" | "mismatch" | "stalePending" | "reconciledAt"> {
  if (!p) return { kind: "NOT_POSTED", label: "Not posted to Cin7", tone: "neutral", invoiceNumber: null, reconciled: false, detail: null };
  const invoiceNumber = p.cin7_invoice_number;
  const reconciled = p.posting_state === "RECONCILED" && !!p.reconciled_at;
  const cin7 = (p.cin7_status ?? "").trim().toUpperCase();
  switch (p.posting_state) {
    case "PENDING":
      return { kind: "POSTING", label: "Posting to Cin7", tone: "warning", invoiceNumber, reconciled: false, detail: "An invoice request is in progress. Do not retry; refresh to see the outcome." };
    case "FAILED_UNCERTAIN":
      return { kind: "UNCERTAIN", label: "Outcome uncertain", tone: "danger", invoiceNumber, reconciled: false, detail: p.last_error_message ?? "Cin7 did not confirm the result. Check Cin7 before doing anything else." };
    case "FAILED_CONFIRMED_NO_WRITE":
      return { kind: "FAILED", label: "Failed - nothing created in Cin7", tone: "danger", invoiceNumber: null, reconciled: false, detail: p.last_error_message ?? null };
    case "CREATED":
    case "RECONCILED": {
      const state = reconciled ? "reconciled" : "created, not yet reconciled";
      if (cin7 === "DRAFT") return { kind: "DRAFT_CREATED", label: "Draft invoice created", tone: "info", invoiceNumber, reconciled, detail: state };
      if (cin7 === "AUTHORISED" || cin7 === "AUTHORIZED") return { kind: "AUTHORISED", label: "Invoice authorised", tone: "success", invoiceNumber, reconciled, detail: state };
      return { kind: "CREATED_OTHER", label: `Invoice created${cin7 ? ` (${cin7.toLowerCase()})` : ""}`, tone: "info", invoiceNumber, reconciled, detail: state };
    }
    default:
      // An unknown state is never shown as "Not posted": a row exists, so something was attempted.
      return { kind: "UNCERTAIN", label: "Posting state unknown", tone: "warning", invoiceNumber, reconciled: false, detail: `Unrecognised posting state ${p.posting_state}.` };
  }
}
