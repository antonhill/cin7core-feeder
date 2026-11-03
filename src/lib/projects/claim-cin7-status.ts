// How a claim's Cin7 position is DISPLAYED. The authoritative source is project_claim_cin7_postings (one row per claim, written by the posting
// flow); the older project_cin7_links table is never written by it. A claim with no posting row is "Not posted"; nothing else is. This is a
// display classifier only - it never decides whether a posting may be (re)tried. Since UX-006g1 the DRAFT / AUTHORISED labels describe the RECORDED snapshot, never the current Cin7 status.

import { isStalePending } from "./posting-staleness";

export interface ClaimPostingRow {
  claim_id: string;
  posting_state: string;
  cin7_invoice_number: string | null;
  cin7_status: string | null;
  reconciled_at: string | null;
  /** When the posting finished (UX-006g1: with reconciled_at it dates the RECORDED cin7_status snapshot). Optional so older fixtures still type. */
  completed_at?: string | null;
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
  // UX-006g1 (additive): the raw evidence behind the label. cin7_status is a SNAPSHOT taken when the invoice was posted or last reconciled; it is never refreshed, so it is
  // not the current Cin7 status. `recordedAt` dates it. Nothing here is a verified status (see invoice-authorisation.ts).
  postingState: string | null;
  recordedStatus: string | null;
  recordedAt: string | null;
  completedAt: string | null;
  reconciledAt: string | null;
  // UX-006g2 (additive): facts for the commercial billing derivation (commercial-billing-state.ts); they never change the label.
  /** CREATED invoice whose last reconciliation recorded AMOUNT_MISMATCH. */
  mismatch: boolean;
  /** A PENDING posting older than the stale window (or with no readable request time): its outcome is unknown. */
  stalePending: boolean;
}

export function claimCin7Status(p: ClaimPostingRow | null | undefined, now: number = Date.now()): ClaimCin7Status {
  const none = { postingState: null, recordedStatus: null, recordedAt: null, completedAt: null, reconciledAt: null, mismatch: false, stalePending: false };
  if (!p) return { kind: "NOT_POSTED", label: "Not posted to Cin7", tone: "neutral", invoiceNumber: null, reconciled: false, detail: null, ...none };
  const invoiceNumber = p.cin7_invoice_number;
  const ev = {
    postingState: p.posting_state, recordedStatus: (p.cin7_status ?? "").trim().toUpperCase() || null,
    recordedAt: p.reconciled_at ?? p.completed_at ?? null, completedAt: p.completed_at ?? null, reconciledAt: p.reconciled_at,
    mismatch: p.posting_state === "CREATED" && p.last_error_code === "AMOUNT_MISMATCH",
    stalePending: p.posting_state === "PENDING" && (!p.requested_at || !Number.isFinite(Date.parse(p.requested_at)) || isStalePending(p.requested_at, now)),
  };
  const reconciled = p.posting_state === "RECONCILED" && !!p.reconciled_at;
  const cin7 = (p.cin7_status ?? "").trim().toUpperCase();
  switch (p.posting_state) {
    case "PENDING":
      return { kind: "POSTING", label: "Posting to Cin7", tone: "warning", invoiceNumber, reconciled: false, detail: "An invoice request is in progress. Do not retry; refresh to see the outcome.", ...ev };
    case "FAILED_UNCERTAIN":
      return { kind: "UNCERTAIN", label: "Outcome uncertain", tone: "danger", invoiceNumber, reconciled: false, detail: p.last_error_message ?? "Cin7 did not confirm the result. Check Cin7 before doing anything else.", ...ev };
    case "FAILED_CONFIRMED_NO_WRITE":
      return { kind: "FAILED", label: "Failed - nothing created in Cin7", tone: "danger", invoiceNumber: null, reconciled: false, detail: p.last_error_message ?? null, ...ev };
    case "CREATED":
    case "RECONCILED": {
      const state = reconciled ? "reconciled" : "created, not yet reconciled";
      if (cin7 === "DRAFT") return { kind: "DRAFT_CREATED", label: "Draft recorded", tone: "info", invoiceNumber, reconciled, detail: state, ...ev };
      if (cin7 === "AUTHORISED" || cin7 === "AUTHORIZED") return { kind: "AUTHORISED", label: "Authorised recorded (not verified)", tone: "info", invoiceNumber, reconciled, detail: state, ...ev };
      return { kind: "CREATED_OTHER", label: `Invoice created${cin7 ? ` (${cin7.toLowerCase()})` : ""}`, tone: "info", invoiceNumber, reconciled, detail: state, ...ev };
    }
    default:
      // An unknown state is never shown as "Not posted": a row exists, so something was attempted.
      return { kind: "UNCERTAIN", label: "Posting state unknown", tone: "warning", invoiceNumber, reconciled: false, detail: `Unrecognised posting state ${p.posting_state}.`, ...ev };
  }
}
