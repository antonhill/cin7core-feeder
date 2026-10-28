import type { Readiness } from "../grower/readiness";
import { hasAny, type QuoteRole } from "./roles";

// QUOTE WORKFLOW (Sean's confirmed process), pure:
//   1 Rep prepares the draft with the customer            REP_DRAFT
//   2 Customer confirms amount/scope with the rep; rep sends to estimator   → ESTIMATOR_REVIEW   (records the customer's confirmation)
//   3 Estimator double-checks everything                  (sign-off recorded; any later edit clears it)
//   4 Manager performs final approval                     → MANAGER_APPROVED_FINAL  (freezes the accepted baseline)
//   5 Manager sends the final quote to the customer; Cin7 push is LATER and not in the POC.
// No e-signature. No Cin7 write.

export const QUOTE_STATES = ["REP_DRAFT", "ESTIMATOR_REVIEW", "MANAGER_APPROVED_FINAL"] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];
export const QUOTE_STATE_LABEL: Record<QuoteState, string> = {
  REP_DRAFT: "Rep draft",
  ESTIMATOR_REVIEW: "Estimator review",
  MANAGER_APPROVED_FINAL: "Manager approved — final",
};

export type QuoteAction = "SEND_TO_ESTIMATOR" | "RETURN_TO_REP" | "ESTIMATOR_SIGN_OFF" | "MANAGER_APPROVE";

const TABLE: Record<QuoteAction, { from: QuoteState; to: QuoteState; roles: readonly QuoteRole[] }> = {
  SEND_TO_ESTIMATOR: { from: "REP_DRAFT", to: "ESTIMATOR_REVIEW", roles: ["rep"] },
  RETURN_TO_REP: { from: "ESTIMATOR_REVIEW", to: "REP_DRAFT", roles: ["estimator", "manager"] },
  // Sign-off does not change state: it records that the estimator double-checked THIS exact content.
  ESTIMATOR_SIGN_OFF: { from: "ESTIMATOR_REVIEW", to: "ESTIMATOR_REVIEW", roles: ["estimator"] },
  MANAGER_APPROVE: { from: "ESTIMATOR_REVIEW", to: "MANAGER_APPROVED_FINAL", roles: ["manager"] },
};

export type TransitionResult = { ok: true; to: QuoteState } | { ok: false; error: string };

/** Role + state check only. Business preconditions are in the check* functions below. */
export function authoriseTransition(roles: ReadonlySet<QuoteRole>, from: QuoteState, action: QuoteAction): TransitionResult {
  const t = TABLE[action];
  if (from === "MANAGER_APPROVED_FINAL") return { ok: false, error: "The accepted quote is final and cannot be changed. Post-acceptance changes must be Variations." };
  if (from !== t.from) return { ok: false, error: `${action} is not possible from ${QUOTE_STATE_LABEL[from]}.` };
  if (!hasAny(roles, t.roles)) return { ok: false, error: `Requires the ${t.roles.join(" / ")} role.` };
  return { ok: true, to: t.to };
}

/** The draft may be edited while it is a rep draft or in estimator review, by a member; never once approved. */
export function canEditDraft(roles: ReadonlySet<QuoteRole>, state: QuoteState): boolean {
  return state !== "MANAGER_APPROVED_FINAL" && hasAny(roles, ["rep", "estimator"]);
}

export type Check = { ok: true } | { ok: false; error: string };
const fail = (error: string): Check => ({ ok: false, error });

/** Rep → Estimator: the quote must be complete (so the customer can confirm a real amount) and the confirmation is recorded. */
export function checkHandoff(i: { readiness: Readiness; totalExVatCents: number | null; confirmedAmountCents: number; confirmedBy: string }): Check {
  if (i.readiness.state !== "READY") return fail(`The quote is ${i.readiness.state} — resolve ${i.readiness.reasons[0] ?? "the outstanding items"} before the customer can confirm an amount.`);
  if (i.totalExVatCents == null || i.totalExVatCents <= 0) return fail("There is no commercial amount for the customer to confirm.");
  if (!i.confirmedBy.trim()) return fail("Record who at the customer confirmed the amount.");
  if (i.confirmedAmountCents !== i.totalExVatCents) return fail("The amount the customer confirmed must equal the quote total (ex VAT).");
  return { ok: true };
}

/**
 * Manager final approval. Fails closed unless EVERYTHING holds on the exact content being approved:
 *   - readiness is READY; - the estimator signed off THIS content (hash matches);
 *   - the total still equals what the customer confirmed at handoff.
 */
export function checkApproval(i: {
  readiness: Readiness;
  totalExVatCents: number | null;
  customerConfirmedCents: number | null;
  signoffHash: string | null;
  currentDraftHash: string;
}): Check {
  if (i.readiness.state !== "READY") return fail(`The quote is ${i.readiness.state}; it cannot be approved.`);
  if (i.totalExVatCents == null || i.totalExVatCents <= 0) return fail("There is no contract value to approve.");
  if (i.customerConfirmedCents == null) return fail("The customer's confirmation was never recorded.");
  if (!i.signoffHash) return fail("The estimator has not signed off this quote.");
  if (i.signoffHash !== i.currentDraftHash) return fail("The quote changed after the estimator signed off. The estimator must review and sign off again.");
  if (i.customerConfirmedCents !== i.totalExVatCents) return fail("The total changed since the customer confirmed it. Return it to the rep to reconfirm with the customer.");
  return { ok: true };
}
