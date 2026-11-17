// The sentence "Price from Cin7" adds to its outcome when it added costs (so the total may have changed). Wording only: the state machine is unchanged (a confirmation is withdrawn, and an Estimator-review quotation returned to
// the Rep, only when a COMPLETE total differs from the confirmed amount; while the quotation is incomplete it stays in Estimator review and sign-off is blocked).
export const INCOMPLETE_RECONFIRM_NOTE = "The quotation total has changed. Complete the remaining pricing and return it to the Rep for reconfirmation before sign-off.";
export const COMPLETE_RECONFIRM_NOTE = "If the Rep had already confirmed an amount and the total has changed, the quotation returns to the Rep to reconfirm it.";
export function reconfirmNote(added: number, incomplete: boolean): string {
  if (added <= 0) return "";
  return incomplete ? INCOMPLETE_RECONFIRM_NOTE : COMPLETE_RECONFIRM_NOTE;
}
