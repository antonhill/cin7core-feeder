// Projects -> Cin7 claim posting: the PURE rules. Generic (nothing here knows about NewQuip) and Cin7-free (no import from src/cin7):
// the server-side store injects the Cin7 port. Everything a posting is built from comes from the FROZEN APPROVED claim — progress is
// never re-read or recalculated.
import { createHash } from "node:crypto";

export const POSTING_STATES = ["PENDING", "CREATED", "RECONCILED", "FAILED_CONFIRMED_NO_WRITE", "FAILED_UNCERTAIN"] as const;
export type PostingState = (typeof POSTING_STATES)[number];
/** NOT_SENT is the ABSENCE of a posting row (no write attempt has occurred); it is never stored. */
export type PostingDisplayState = PostingState | "NOT_SENT";

/** The exact words a manager must confirm (checked server-side, not just shown). */
export const POST_CONFIRMATION_TEXT = "Create a Cin7 invoice for this approved claim";
/** A PENDING row older than this is presumed orphaned (the process died mid-call) and must be reconciled before anything else. */
export const STALE_PENDING_MS = 5 * 60 * 1000;

export const MESSAGES = {
  safeFailure: "Cin7 rejected the request. No invoice was created.",
  uncertain: "The request outcome is uncertain. Do not retry until Cin7 has been reconciled.",
  mismatch: "A Cin7 invoice was found but its value does not match the approved claim.",
  inFlight: "A posting for this claim is already in progress.",
} as const;

export const idempotencyKeyFor = (projectRef: string, claimNumber: string, claimId: string): string => `NEWQUIP:${projectRef}:${claimNumber}:${claimId}`;
/** Stable, searchable reconciliation reference carried in the Cin7 invoice Memo. */
export const memoFor = (projectRef: string, claimNumber: string): string => `NEWQUIP-PROJECTS:${projectRef}:${claimNumber}`;

export interface PostingClaim {
  id: string;
  claim_number: string;
  status: string;
  tax_rate_bps: number;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
}
export interface PostingClaimLine { stage_name: string; current_claim_cents: number; tax_cents: number }
export interface PostingLink { id: string; cin7_sale_id: string; tax_rule: string; revenue_account: string }

export interface PostingCharge { description: string; amountCents: number; taxCents: number }
export interface PostingPlan {
  idempotencyKey: string;
  memo: string;
  fingerprint: string;
  charges: PostingCharge[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxRatePct: number;
}

const claimSuffix = (claimNumber: string): string => claimNumber.split("-").at(-1) ?? claimNumber;
export const rands = (cents: number): number => cents / 100;

/**
 * Builds the posting plan from the APPROVED claim record, or explains why it cannot. Fails closed on any arithmetic doubt. Each charge
 * carries the claim's own FROZEN per-line VAT amount (that exact figure is what is sent as `Tax`); the lines must reconcile with the
 * claim's rate and totals first, otherwise nothing is sent.
 */
export function buildPostingPlan(i: { projectRef: string; claim: PostingClaim; lines: PostingClaimLine[]; link: PostingLink }): { ok: true; plan: PostingPlan } | { ok: false; error: string } {
  const { claim, lines, projectRef, link } = i;
  if (claim.status !== "APPROVED") return { ok: false, error: `Only an APPROVED claim can be posted (this one is ${claim.status}).` };
  if (lines.length === 0) return { ok: false, error: "The approved claim has no lines." };
  const ratePct = claim.tax_rate_bps / 100;
  const sum = lines.reduce((n, l) => n + l.current_claim_cents, 0);
  if (sum !== claim.subtotal_cents) return { ok: false, error: "The claim lines do not add up to the claim subtotal." };
  let tax = 0;
  const charges: PostingCharge[] = [];
  for (const l of lines) {
    const expectedTax = Math.round((l.current_claim_cents * claim.tax_rate_bps) / 10_000);
    if (!Number.isSafeInteger(l.current_claim_cents) || !Number.isSafeInteger(l.tax_cents) || l.current_claim_cents <= 0 || l.tax_cents < 0) return { ok: false, error: `The amounts on "${l.stage_name}" are not valid; nothing was sent.` };
    if (expectedTax !== l.tax_cents) return { ok: false, error: `VAT on "${l.stage_name}" does not match the claim's rate (${expectedTax} vs ${l.tax_cents} cents). Nothing was sent.` };
    tax += l.tax_cents;
    charges.push({ description: `${projectRef} - ${l.stage_name} progress claim ${claimSuffix(claim.claim_number)}`, amountCents: l.current_claim_cents, taxCents: l.tax_cents });
  }
  if (tax !== claim.tax_cents || claim.subtotal_cents + claim.tax_cents !== claim.total_cents) return { ok: false, error: "The claim's VAT/total do not reconcile; nothing was sent." };
  const memo = memoFor(projectRef, claim.claim_number);
  const body = { saleId: link.cin7_sale_id, memo, taxRule: link.tax_rule, account: link.revenue_account, ratePct, charges, subtotal: claim.subtotal_cents, tax: claim.tax_cents, total: claim.total_cents };
  return {
    ok: true,
    plan: {
      idempotencyKey: idempotencyKeyFor(projectRef, claim.claim_number, claim.id),
      memo,
      fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      charges, subtotalCents: claim.subtotal_cents, taxCents: claim.tax_cents, totalCents: claim.total_cents, taxRatePct: ratePct,
    },
  };
}

/** Amounts are integer cents, or null when Cin7 did not return a readable number. Null is NEVER read as zero and NEVER matches. */
export interface ReadInvoice { invoiceNumber: string | null; taskId: string | null; memo: string | null; status: string | null; subtotalCents: number | null; taxCents: number | null; totalCents: number | null }

export type MatchResult =
  | { kind: "not_found" }
  | { kind: "multiple"; count: number }
  | { kind: "matched"; invoice: ReadInvoice }
  | { kind: "mismatch"; invoice: ReadInvoice; differences: string[] };

const isCents = (n: number | null): n is number => typeof n === "number" && Number.isSafeInteger(n);
const rand = (cents: number) => (cents / 100).toFixed(2);

/** Differences between what Cin7 holds and what was frozen, in rands. A missing / non-finite Cin7 amount is itself a difference. */
export function amountDifferences(
  cin7: { subtotalCents: number | null; taxCents: number | null; totalCents: number | null },
  frozen: { amount_ex_vat_cents: number; tax_cents: number; total_cents: number },
): string[] {
  const out: string[] = [];
  const check = (label: string, got: number | null, want: number) => {
    if (!isCents(got)) out.push(`${label} not returned by Cin7 (expected R${rand(want)})`);
    else if (got !== want) out.push(`${label} R${rand(got)} vs approved R${rand(want)}`);
  };
  check("ex VAT", cin7.subtotalCents, frozen.amount_ex_vat_cents);
  check("VAT", cin7.taxCents, frozen.tax_cents);
  check("total", cin7.totalCents, frozen.total_cents);
  return out;
}

/** Matches Cin7's invoices (read back from the linked Sale) to a posting by its EXACT memo, then checks the amounts. A voided invoice is not a match. */
export function matchInvoices(invoices: ReadInvoice[], posting: { memo: string; amount_ex_vat_cents: number; tax_cents: number; total_cents: number }): MatchResult {
  const mine = invoices.filter((inv) => inv.memo === posting.memo && (inv.status ?? "").toUpperCase() !== "VOIDED");
  if (mine.length === 0) return { kind: "not_found" };
  if (mine.length > 1) return { kind: "multiple", count: mine.length };
  const inv = mine[0];
  const differences = amountDifferences({ subtotalCents: inv.subtotalCents, taxCents: inv.taxCents, totalCents: inv.totalCents }, posting);
  return differences.length ? { kind: "mismatch", invoice: inv, differences } : { kind: "matched", invoice: inv };
}

export const isStalePending = (requestedAt: string, now: number = Date.now()): boolean => now - Date.parse(requestedAt) > STALE_PENDING_MS;

/** Whether a manager may retry (re-send) a posting in this state. Only a CONFIRMED no-write failure — never CREATED/RECONCILED/PENDING/UNCERTAIN. */
export const canRetry = (state: PostingDisplayState): boolean => state === "FAILED_CONFIRMED_NO_WRITE";
/** Whether the first send is possible. */
export const canSend = (state: PostingDisplayState): boolean => state === "NOT_SENT" || state === "FAILED_CONFIRMED_NO_WRITE";
/** Whether a read-only reconciliation is meaningful. */
export const canReconcile = (state: PostingDisplayState): boolean => state === "PENDING" || state === "CREATED" || state === "FAILED_UNCERTAIN";
