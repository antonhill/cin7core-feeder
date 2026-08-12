import type { SubscriptionStatus } from "@/lib/billing";

/**
 * The subscription statuses that permit Cin7 writes. Kept in this tiny,
 * dependency-free module (rather than inline in billing.ts) so it can be
 * imported from edge middleware without dragging billing.ts's service-role /
 * Lemon Squeezy imports into the edge bundle. The `import type` above is erased
 * at runtime, so this module has no runtime dependency on billing.ts.
 *
 * Single source of truth: billing.ts's `toBillingStatus` computes `canWrite`
 * from this same helper.
 */
const WRITE_ALLOWED_STATUSES = new Set<SubscriptionStatus>(["active"]);

/** Pure — whether an org on this subscription status may perform Cin7 writes. */
export function writeAllowedFor(status: SubscriptionStatus): boolean {
  return WRITE_ALLOWED_STATUSES.has(status);
}
