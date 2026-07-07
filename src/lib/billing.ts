import { createServiceRoleClient } from "@/supabase/server";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

export interface BillingStatus {
  status: SubscriptionStatus;
  trialEndsAt: string;
  maxInstances: number;
  /**
   * False for the entire trial (not just once trialEndsAt passes — Anton's
   * explicit decision) and for a lapsed subscription (past_due/canceled),
   * which degrades to the same read-only state a trial is in. True only
   * once status is "active".
   */
  canWrite: boolean;
}

const WRITE_ALLOWED_STATUSES = new Set<SubscriptionStatus>(["active"]);

/** Pure — no I/O, easy to unit test independently of the DB row shape. */
export function toBillingStatus(row: { subscription_status: SubscriptionStatus; trial_ends_at: string; max_instances: number }): BillingStatus {
  return {
    status: row.subscription_status,
    trialEndsAt: row.trial_ends_at,
    maxInstances: row.max_instances,
    canWrite: WRITE_ALLOWED_STATUSES.has(row.subscription_status),
  };
}

export async function getBillingStatus(orgId: string): Promise<BillingStatus> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("organizations")
    .select("subscription_status, trial_ends_at, max_instances")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return toBillingStatus(data);
}

/** Throws a user-facing message if this org isn't allowed to write back to Cin7 right now — called by every write action right after requireCurrentOrg(), before any Cin7 call. */
export async function requireWriteAllowed(orgId: string): Promise<void> {
  const billing = await getBillingStatus(orgId);
  if (!billing.canWrite) {
    throw new Error(
      billing.status === "trialing"
        ? "This is a read-only trial feature — subscribe to write changes back to Cin7."
        : "Your subscription isn't active — subscribe to write changes back to Cin7."
    );
  }
}
