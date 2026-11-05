// The ONE "what happens next" line on a variation (UX-006 PR f), like claimNextStep. Pure and display-only: it never decides or authorises anything,
// and it names who must act when the viewer cannot. Flow: raise, price, submit, approved, start billing, schedule, claims.
export type VariationNextInput = {
  status: string;
  amountCents: number;
  isAdmin: boolean;
  /** Billing figures for this variation have loaded (false = still loading or unavailable: do not guess). */
  billingLoaded: boolean;
  billingStarted: boolean;
  /** Approved but no schedule was ever set (legacy). */
  scheduleMissing: boolean;
  /** This variation's own claimable-now amount, when its billing position is known. */
  claimableCents?: number;
  /** This variation's own remaining (unbilled) amount, when known. */
  remainingCents?: number;
};

export function variationNextStep(v: VariationNextInput): string {
  switch (v.status) {
    case "REJECTED": return "Closed: rejected. Raise a new variation if the change is still needed.";
    case "DRAFT":
      if (v.amountCents <= 0) return "Set a price (Re-price), then submit it for approval.";
      return v.isAdmin
        ? "If it has not been submitted, submit it for approval; if it has, it is waiting for a manager. You can approve or reject it here or in Approvals."
        : "If it has not been submitted, submit it for approval; if it has, it is waiting for a manager to approve.";
    case "APPROVED": break;
    default: return "Status not recognised: nothing to do here.";
  }
  if (!v.billingLoaded) return "Billing status is still loading.";
  if (v.scheduleMissing) return v.isAdmin ? "Set its billing schedule (an audited amendment) before billing can start." : "A manager must set its billing schedule before billing can start.";
  if (!v.billingStarted) return v.isAdmin ? "Check the billing schedule (default one 100% stage), then Start variation billing." : "A manager checks the schedule and starts variation billing.";
  if ((v.claimableCents ?? 0) > 0) return v.isAdmin ? "Billing has started and value is claimable: open the billing workspace to prepare a claim." : "Billing has started and value is claimable: a manager prepares the claim.";
  if (v.claimableCents === undefined) return v.isAdmin ? "Billing has started. Open the billing workspace to see what can be claimed." : "Billing has started. A manager prepares claims.";
  if (v.remainingCents === 0) return "Billing has started and everything is already billed or committed.";
  return v.isAdmin
    ? "Billing has started but nothing is claimable yet. In the billing workspace check whether commercial progress is approved; a blocked schedule or an uncertain claim also stops claiming."
    : "Billing has started but nothing is claimable yet. A manager checks commercial progress there (a blocked schedule or an uncertain claim also stops claiming).";
}
