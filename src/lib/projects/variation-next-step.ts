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
};

export function variationNextStep(v: VariationNextInput): string {
  switch (v.status) {
    case "REJECTED": return "Closed: rejected. Raise a new variation if the change is still needed.";
    case "DRAFT":
      if (v.amountCents <= 0) return "Set a price (Re-price), then submit it for approval.";
      return v.isAdmin
        ? "Submit it for approval, or approve or reject it here as a manager. Once submitted it waits for a manager."
        : "Submit it for approval (or re-price first). Once submitted, a manager must approve it.";
    case "APPROVED": break;
    default: return "Status not recognised: nothing to do here.";
  }
  if (!v.billingLoaded) return "Billing status is still loading.";
  if (v.scheduleMissing) return v.isAdmin ? "Set its billing schedule (an audited amendment) before billing can start." : "A manager must set its billing schedule before billing can start.";
  if (!v.billingStarted) return v.isAdmin ? "Check the billing schedule (default one 100% stage), then Start variation billing." : "A manager checks the schedule and starts variation billing.";
  if ((v.claimableCents ?? 0) > 0) return v.isAdmin ? "Billing has started and value is claimable: open the billing workspace to prepare a claim." : "Billing has started and value is claimable: a manager prepares the claim.";
  return v.isAdmin ? "Billing has started. In the billing workspace, approve commercial progress, then prepare a claim." : "Billing has started. A manager approves commercial progress and prepares claims.";
}
