// COMMERCIAL BILLING STATE of one billing scope (PURE; no reads, no actions, no stores). One derivation shared by every screen that says whether a scope
// is billed, so Journey, Overview, Variations and the consolidated report cannot disagree.
//
// Why it is derived from POSTINGS: project_claims.status stays APPROVED forever after a claim is posted and reconciled (nothing writes CIN7_PENDING,
// CIN7_CREATED or RECONCILED onto a claim), so a rule that waits for a claim status of RECONCILED can never be true. The authoritative facts are the
// Cin7 posting row (posting_state, reconciled_at, AMOUNT_MISMATCH on a CREATED row, requested_at for a stale PENDING) and the stage ledger.
//
// This is COMMERCIAL billing only. Physical fulfilment, delivery, customer payment and Cin7 invoice authorisation never affect the result, and there is
// no project closure state. The dead claim statuses (CIN7_PENDING / CIN7_CREATED / RECONCILED) are never read.
export type CommercialBillingStateKey = "NOT_STARTED" | "IN_PROGRESS" | "NEEDS_ATTENTION" | "COMPLETE";

/** The posting facts of one claim. null = the claim has no posting row. */
export interface BillingPostingFact {
  posting_state: string;
  /** reconciled_at is set: RECONCILED without it is not counted as reconciled. */
  reconciled_at?: string | null;
  /** CREATED invoice with a recorded AMOUNT_MISMATCH. */
  mismatch?: boolean;
  /** PENDING older than the stale window (or without a readable time). */
  stalePending?: boolean;
}
export interface BillingClaimFact { status: string; posting: BillingPostingFact | null }
export interface BillingStageFact { valueCents: number; committedCents: number; belowCommitted?: boolean }

export interface CommercialBillingInput {
  scope: "BASE" | "VARIATION";
  claims: readonly BillingClaimFact[];
  stages: readonly BillingStageFact[];
  scheduleBalanced?: boolean;
  /** A claim is FAILED_UNCERTAIN at the project level (blocks further claiming). */
  uncertainClaimBlocking?: boolean;
  /** VARIATION: the approved variation amount (ex VAT). Complete requires the scope's committed total to equal it. */
  approvedAmountCents?: number;
  /** VARIATION: billing has been started (a billing project exists). */
  billingStarted?: boolean;
}

export interface CommercialBillingCounts {
  /** Claims that are not cancelled and not a confirmed no-write failure. */
  live: number;
  reconciled: number;
  uncertain: number;
  mismatched: number;
  /** CREATED (or RECONCILED without reconciled_at) with no mismatch, waiting to be reconciled. */
  awaitingReconciliation: number;
  /** PENDING within the normal window. */
  sending: number;
  /** Draft or submitted claims. */
  preparing: number;
  /** APPROVED and live but with no posting row. */
  approvedUnposted: number;
  /** A cancelled / no-write claim that still has a posting that is live or unresolved (PENDING, CREATED, RECONCILED, FAILED_UNCERTAIN, unknown). */
  cancelledWithPosting: number;
  /** APPROVED whose posting is a confirmed no-write failure: nothing in Cin7, can be retried. */
  retryable: number;
}
export interface CommercialBillingResult { state: CommercialBillingStateKey; reasons: string[]; counts: CommercialBillingCounts }

/** Claim statuses that never count: nothing was ever sent, or Cin7 confirmed nothing was created. */
const NOT_LIVE = new Set(["CANCELLED_BEFORE_WRITE", "FAILED_CONFIRMED_NO_WRITE"]);
const PREPARING = new Set(["DRAFT", "READY_FOR_APPROVAL"]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function commercialBillingState(input: CommercialBillingInput): CommercialBillingResult {
  const counts: CommercialBillingCounts = { live: 0, reconciled: 0, uncertain: 0, mismatched: 0, awaitingReconciliation: 0, sending: 0, preparing: 0, approvedUnposted: 0, cancelledWithPosting: 0, retryable: 0 };
  let liveAllReconciled = true;

  for (const c of input.claims) {
    const p = c.posting;
    // An APPROVED claim whose posting was a confirmed no-write failure: not live (nothing created), but it is approved value that has not been invoiced.
    if (p?.posting_state === "FAILED_CONFIRMED_NO_WRITE" && c.status === "APPROVED") { counts.retryable += 1; continue; }
    if (NOT_LIVE.has(c.status)) {
      // Ignored only when it has no posting (or a confirmed no-write one). A cancelled claim that still has a live or unresolved posting contradicts itself: never skipped.
      if (p && p.posting_state !== "FAILED_CONFIRMED_NO_WRITE") { counts.cancelledWithPosting += 1; liveAllReconciled = false; }
      continue;
    }
    counts.live += 1;
    if (PREPARING.has(c.status) && !p) { counts.preparing += 1; liveAllReconciled = false; continue; }
    if (!p) {
      if (c.status === "FAILED_UNCERTAIN") counts.uncertain += 1;
      else counts.approvedUnposted += 1;
      liveAllReconciled = false;
      continue;
    }
    switch (p.posting_state) {
      case "RECONCILED":
        if (p.reconciled_at) counts.reconciled += 1; else { counts.awaitingReconciliation += 1; liveAllReconciled = false; }
        break;
      case "CREATED":
        if (p.mismatch) counts.mismatched += 1; else counts.awaitingReconciliation += 1;
        liveAllReconciled = false;
        break;
      case "PENDING":
        if (p.stalePending) counts.uncertain += 1; else counts.sending += 1;
        liveAllReconciled = false;
        break;
      case "FAILED_UNCERTAIN":
      default: // an unrecognised posting state is never treated as fine
        counts.uncertain += 1;
        liveAllReconciled = false;
    }
  }

  const committed = input.stages.reduce((n, s) => n + s.committedCents, 0);
  const attention: string[] = [];
  if (counts.uncertain > 0) attention.push(`${plural(counts.uncertain, "posting has", "postings have")} an uncertain outcome and must be reconciled before anything else`);
  if (counts.mismatched > 0) attention.push(`${plural(counts.mismatched, "Cin7 invoice has", "Cin7 invoices have")} a recorded amount mismatch`);
  if (counts.approvedUnposted > 0) attention.push(`${plural(counts.approvedUnposted, "approved claim is", "approved claims are")} not posted to Cin7 yet`);
  if (counts.cancelledWithPosting > 0) attention.push(`${plural(counts.cancelledWithPosting, "cancelled claim still has", "cancelled claims still have")} a Cin7 posting that is not resolved`);
  if (counts.retryable > 0) attention.push(`${plural(counts.retryable, "approved claim was", "approved claims were")} not created in Cin7 (can be retried)`);
  if (input.stages.some((s) => s.belowCommitted)) attention.push("approved progress is below what has been billed on a stage");
  if (input.scheduleBalanced === false) attention.push("stage values do not add up to the contract");
  if (input.uncertainClaimBlocking) attention.push("a claim with an uncertain outcome is blocking further claims");
  const over = input.stages.filter((s) => s.committedCents > s.valueCents).length;
  if (over > 0) attention.push(`${plural(over, "stage is", "stages are")} over-billed (billed more than the stage value)`);
  if (input.scope === "VARIATION" && input.approvedAmountCents !== undefined && committed > input.approvedAmountCents) attention.push("billed more than the approved variation amount");
  if (attention.length > 0) return { state: "NEEDS_ATTENTION", reasons: attention, counts };

  if (counts.live === 0 && committed === 0) return { state: "NOT_STARTED", reasons: ["no claims have been raised yet"], counts };

  const progress: string[] = [];
  if (counts.preparing > 0) progress.push(`${plural(counts.preparing, "claim is", "claims are")} still being prepared or awaiting approval`);
  if (counts.sending > 0) progress.push(`${plural(counts.sending, "posting is", "postings are")} still being sent to Cin7`);
  if (counts.awaitingReconciliation > 0) progress.push(`${plural(counts.awaitingReconciliation, "Cin7 invoice is", "Cin7 invoices are")} awaiting reconciliation`);
  // BASE: every stage fully billed (project-level remaining includes variations, so it is never used). VARIATION: the billed total equals the approved amount.
  const fullyBilled = input.scope === "BASE"
    ? input.stages.length > 0 && input.stages.every((s) => s.committedCents >= s.valueCents)
    : input.billingStarted === true && input.approvedAmountCents !== undefined && committed === input.approvedAmountCents;
  if (!fullyBilled) progress.push(input.scope === "BASE" ? "not every stage is fully billed yet" : "the approved variation amount is not fully billed yet");
  if (progress.length > 0 || counts.live === 0 || !liveAllReconciled) {
    return { state: "IN_PROGRESS", reasons: progress.length > 0 ? progress : ["no claim has been billed and reconciled yet"], counts };
  }
  return { state: "COMPLETE", reasons: [], counts };
}

export const COMMERCIAL_BILLING_LABEL: Record<CommercialBillingStateKey, string> = {
  NOT_STARTED: "Not started", IN_PROGRESS: "In progress", NEEDS_ATTENTION: "Needs attention", COMPLETE: "Complete",
};
/** The wording every screen uses. Always "Commercial billing": it never implies physical fulfilment, payment or project completion. */
export const commercialBillingText = (r: Pick<CommercialBillingResult, "state">): string => `Commercial billing: ${COMMERCIAL_BILLING_LABEL[r.state]}`;

// ── adapters (pure) ─────────────────────────────────────────────────────────────────────────────────────────

/** The minimal shape of a ProjectView claim / stage this derivation needs (kept structural so callers pass project-view rows without a conversion). */
export interface ViewClaimLike {
  status: string;
  cin7Status: { postingState: string | null; reconciledAt: string | null; mismatch: boolean; stalePending: boolean };
}
export function billingClaimFact(c: ViewClaimLike): BillingClaimFact {
  const k = c.cin7Status;
  return { status: c.status, posting: k.postingState === null ? null : { posting_state: k.postingState, reconciled_at: k.reconciledAt, mismatch: k.mismatch, stalePending: k.stalePending } };
}
export interface ViewLike {
  claims: readonly ViewClaimLike[];
  stages: readonly BillingStageFact[];
  commercial: { scheduleBalanced: boolean; uncertainClaimBlocking: boolean };
}
/** Derivation for a loaded billing-project view (BASE, or a variation's own billing project). */
export function commercialBillingFromView(view: ViewLike, scope: "BASE" | "VARIATION", variation?: { approvedAmountCents: number; billingStarted: boolean }): CommercialBillingResult {
  return commercialBillingState({
    scope, claims: view.claims.map(billingClaimFact), stages: view.stages.map((s) => ({ valueCents: s.valueCents, committedCents: s.committedCents, belowCommitted: s.belowCommitted })),
    scheduleBalanced: view.commercial.scheduleBalanced, uncertainClaimBlocking: view.commercial.uncertainClaimBlocking,
    ...(variation ? { approvedAmountCents: variation.approvedAmountCents, billingStarted: variation.billingStarted } : {}),
  });
}

/**
 * Derivation for a variation from what the Variations tab already has: the posting counts of its own billing project plus its committed total. The summary has
 * no claim rows, so the postings' ex-VAT total is compared with the committed total (any difference needs attention; unknown is never COMPLETE).
 */
export interface PostingCountsLike {
  reconciled: number; awaiting: number; mismatched: number; uncertain: number; inProgress: number;
  /** Postings that are a confirmed no-write failure. */
  retryable?: number;
  /** Ex-VAT total of every posting that accounts for committed value (all but a confirmed no-write failure). REQUIRED: null = not known, which can never be COMPLETE. */
  postingExVatCents: number | null;
}
export function commercialBillingFromSummary(r: PostingCountsLike, v: { approvedAmountCents: number; committedCents: number; billingStarted: boolean }): CommercialBillingResult {
  const claims: BillingClaimFact[] = [];
  const add = (n: number, status: string, posting: BillingPostingFact | null) => { for (let i = 0; i < n; i += 1) claims.push({ status, posting }); };
  add(r.reconciled, "APPROVED", { posting_state: "RECONCILED", reconciled_at: "recorded" });
  add(r.awaiting, "APPROVED", { posting_state: "CREATED" });
  add(r.mismatched, "APPROVED", { posting_state: "CREATED", mismatch: true });
  add(r.uncertain, "APPROVED", { posting_state: "FAILED_UNCERTAIN" });
  add(r.inProgress, "APPROVED", { posting_state: "PENDING", stalePending: false });
  add(r.retryable ?? 0, "APPROVED", { posting_state: "FAILED_CONFIRMED_NO_WRITE" });
  const res = commercialBillingState({
    scope: "VARIATION", claims, stages: [{ valueCents: v.approvedAmountCents, committedCents: v.committedCents }],
    approvedAmountCents: v.approvedAmountCents, billingStarted: v.billingStarted,
  });
  // The summary has no claim rows, so the posted amount is checked against the billed amount instead, conservatively: any difference needs attention, and an unknown posted
  // amount is "not verified", never COMPLETE.
  const posted = r.postingExVatCents;
  if (posted !== null && posted !== v.committedCents) {
    const why = posted < v.committedCents ? "the posted amount is below the billed amount (approved value not posted to Cin7)" : "the posted amount is above the billed amount";
    return { state: "NEEDS_ATTENTION", reasons: [why, ...(res.state === "NEEDS_ATTENTION" ? res.reasons : [])], counts: res.counts };
  }
  if (posted === null && res.state === "COMPLETE") return { state: "IN_PROGRESS", reasons: ["the posted amounts could not be verified against the billed amount"], counts: res.counts };
  return res;
}

/**
 * How a claim's posting reads next to its status (concept A: the Toolbox's own record, not Cin7 authorisation and not payment). Claim status stays "Approved"
 * after posting, so this is what says whether it has been invoiced. null = nothing to add (a draft, or a claim that never got a posting and is not approved).
 */
export function claimPostingText(c: { status: string; postingState: string | null; invoiceNumber: string | null; reconciled: boolean; mismatch: boolean; stalePending?: boolean }): string | null {
  const inv = c.invoiceNumber ? ` as ${c.invoiceNumber}` : "";
  switch (c.postingState) {
    case null:
      return c.status === "APPROVED" ? "Not posted to Cin7 yet" : null;
    case "RECONCILED": return c.reconciled ? `Reconciled${inv}` : `Posted${inv}, not reconciled yet`;
    case "CREATED": return c.mismatch ? `Posted${inv}, amount mismatch recorded` : `Posted${inv}, not reconciled yet`;
    case "PENDING": return c.stalePending ? "Posting outcome uncertain" : "Posting to Cin7";
    case "FAILED_CONFIRMED_NO_WRITE": return "Not created in Cin7 (can be retried)";
    default: return "Posting outcome uncertain";
  }
}
