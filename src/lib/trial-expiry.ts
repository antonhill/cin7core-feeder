export const TRIAL_DELETION_GRACE_DAYS = 14;

/**
 * Confirmed live 2026-07-09: subscription_status stays "trialing" forever
 * unless a real billing integration moves it off — trial_ends_at itself is
 * never cleared on conversion (no such integration exists yet). Gating on
 * status (not just the date) is what protects any org that ever went
 * active/past_due/canceled from being auto-deleted, no matter how old
 * trial_ends_at is.
 */
export function isEligibleForTrialAutoDeletion(
  subscriptionStatus: string,
  trialEndsAt: string | null,
  now: Date = new Date()
): boolean {
  if (subscriptionStatus !== "trialing" || !trialEndsAt) return false;
  return now.getTime() > trialAutoDeletionDate(trialEndsAt).getTime();
}

/** The date an org's trial will make it eligible for automatic deletion — TRIAL_DELETION_GRACE_DAYS after trial_ends_at, independent of subscription_status (callers still need isEligibleForTrialAutoDeletion for the status gate). */
export function trialAutoDeletionDate(trialEndsAt: string): Date {
  return new Date(new Date(trialEndsAt).getTime() + TRIAL_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
}
