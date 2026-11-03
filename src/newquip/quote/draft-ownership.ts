import type { QuoteDraft } from "../grower/draft";
import type { QuoteRole } from "./roles";

// FIELD-LEVEL OWNERSHIP OF A SAVED DRAFT (UX-006 / security review P2). `canEditDraft` lets a Rep save the whole draft, so the server must also decide WHICH FIELDS the
// caller may change. A caller without Estimator or Manager authority (a Rep) can never change the Estimator-owned fields: whatever the browser sends for them is
// replaced by the stored values. Rep-owned fields (customer, site, configuration/quantities/exclusions, charges, the M75 price, assumptions) pass through untouched.
// Pure. Estimator / Manager callers are unaffected (their own gates - mapping verification, price-resolution stamping, cost stamping - still run).
//
// Estimator-owned (the audit's ownership matrix): estimator.confirmedMappings, confirmedPackages, priceResolutions, costOverrides, physicalCosts, costBasis.

export const ESTIMATOR_OWNED_DRAFT_FIELDS = ["confirmedMappings", "confirmedPackages", "priceResolutions", "costOverrides", "physicalCosts", "costBasis"] as const;

export const hasEstimatorAuthority = (roles: ReadonlySet<QuoteRole>): boolean => roles.has("estimator") || roles.has("manager");

export function keepEstimatorOwnedFields<D extends QuoteDraft>(draft: D, prior: QuoteDraft | undefined, roles: ReadonlySet<QuoteRole>): D {
  if (hasEstimatorAuthority(roles)) return draft;
  const next = structuredClone(draft);
  const before = prior?.estimator;
  next.estimator.confirmedMappings = structuredClone(before?.confirmedMappings ?? {});
  next.estimator.confirmedPackages = structuredClone(before?.confirmedPackages ?? []);
  next.estimator.priceResolutions = structuredClone(before?.priceResolutions ?? {});
  for (const k of ["costOverrides", "physicalCosts", "costBasis"] as const) {
    if (before?.[k] !== undefined) (next.estimator as unknown as Record<string, unknown>)[k] = structuredClone(before[k]); else delete next.estimator[k];
  }
  return next;
}
