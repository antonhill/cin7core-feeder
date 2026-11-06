// NEWQUIP POC ROLES. The platform has two org tiers (member, owner/admin) — there is no per-user rep/estimator/manager role
// table yet. The POC therefore maps tiers to the roles Sean named, FAILING CLOSED:
//
//   member        → rep, estimator   (prepare the draft, hand off, enter estimator inputs, report PHYSICAL progress, raise/price variations)
//   owner / admin → rep, estimator, manager   (additionally: final approval, COMMERCIAL progress approval, variation approval, cost visibility)
//
// Anything unrecognised gets NO roles. Segregation of duties between a given rep and a given estimator is a post-POC concern
// (it needs a role table); the POC records who did each step instead.

export type QuoteRole = "rep" | "estimator" | "manager";
export type OrgTier = "member" | "admin" | "none";

export function rolesFor(tier: OrgTier): ReadonlySet<QuoteRole> {
  if (tier === "admin") return new Set<QuoteRole>(["rep", "estimator", "manager"]);
  if (tier === "member") return new Set<QuoteRole>(["rep", "estimator"]);
  return new Set<QuoteRole>();
}

export const PHYSICAL_PROGRESS_ROLES: readonly QuoteRole[] = ["rep", "estimator"];
export const COMMERCIAL_APPROVAL_ROLES: readonly QuoteRole[] = ["manager"];
/** Creating a Project from an accepted quotation hands it to delivery and billing: Manager authority only (a plain Rep/Estimator member cannot). */
export const PROJECT_CREATE_ROLES: readonly QuoteRole[] = ["manager"];
export const VARIATION_PREPARE_ROLES: readonly QuoteRole[] = ["estimator", "manager"];
export const VARIATION_APPROVE_ROLES: readonly QuoteRole[] = ["manager"];

export function hasAny(roles: ReadonlySet<QuoteRole>, allowed: readonly QuoteRole[]): boolean {
  return allowed.some((r) => roles.has(r));
}
