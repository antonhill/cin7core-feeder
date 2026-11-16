import { PROJECT_MARKUP_PCT } from "../../grower/workbook-price-source";
import type { PricingRuleVersion } from "./types";

// THE RULE-VERSION REGISTRY. Selection is EXPLICIT: nothing selects a version by default except `legacy`, and a version whose status is not legacy/approved is refused.
// The legacy version READS the existing project markup constant (it does not copy it), so it cannot drift from what the POC engine does today.

export const LEGACY_RULE_VERSION: PricingRuleVersion = {
  id: "legacy-poc-v1",
  label: "Grower POC workbook rules (as in force at NQ-008A)",
  status: "legacy",
  markupBps: PROJECT_MARKUP_PCT * 100,
  unverifiedCost: "flag",
  freightUnspecified: "flag",
  spotRateMaxAgeHours: 24, // PROPOSED default, subject to NewQuip's confirmation
  forwardCoverNeedsValidity: true,
  costReview: { reviewerRoles: ["manager"], requireIndependent: true }, // PROVISIONAL: reviewer roles are not NewQuip's final assignment
  rateReview: { reviewerRoles: ["manager"], requireIndependent: true }, // PROVISIONAL: reviewer roles are not NewQuip's final assignment
};

/**
 * AUTOMATIC SUPPLIER PRICING (Cin7 costs + Manager-entered commercial settings). Versioned: it is a NEW version and legacy-poc-v1 is untouched, so no existing quotation changes.
 *  - freightUnspecified "block": a line with no freight recorded is NOT priced (legacy silently assumed factor 1).
 *  - spotRateMaxAgeHours null: rate freshness is enforced from the Manager's commercial settings (fxMaxAgeDays) when costs are built, not by a number invented here.
 *  - markupBps: the existing legacy value is the DEFAULT only; a Manager-entered markup is applied as an attributed project markup (see auto-costing.ts). Not an approved policy.
 *  - status "provisional": never "approved".
 */
export const SUPPLIER_AUTO_RULE_VERSION: PricingRuleVersion = {
  id: "newquip-supplier-v1",
  label: "NewQuip supplier pricing, Cin7 costs and Manager-entered commercial settings (provisional)",
  status: "provisional",
  markupBps: PROJECT_MARKUP_PCT * 100,
  unverifiedCost: "flag",
  freightUnspecified: "block",
  spotRateMaxAgeHours: null,
  forwardCoverNeedsValidity: true,
  costReview: { reviewerRoles: ["manager"], requireIndependent: true },
  rateReview: { reviewerRoles: ["manager"], requireIndependent: true },
};

// The registry holds ONLY versions a quotation may use. Development fixture versions live in fixtures.ts and are not in it, so they cannot be found, let alone selected.
const REGISTRY: readonly PricingRuleVersion[] = [LEGACY_RULE_VERSION, SUPPLIER_AUTO_RULE_VERSION];

/** The version a quotation uses when nobody has explicitly selected another: always the legacy POC rules, so existing prices do not move. */
export const DEFAULT_RULE_VERSION_ID = LEGACY_RULE_VERSION.id;

export type RuleSelection = { ok: true; rules: PricingRuleVersion } | { ok: false; error: string };

/** The ONLY way a quotation obtains rules. There is no option to allow a draft: a draft is refused even if one were ever added to the registry. */
export function selectRuleVersion(id: string | null | undefined): RuleSelection {
  const wanted = id ?? DEFAULT_RULE_VERSION_ID;
  const rules = REGISTRY.find((r) => r.id === wanted);
  if (!rules) return { ok: false, error: `Unknown pricing rule version "${wanted}".` };
  if (rules.status === "draft") return { ok: false, error: `Pricing rule version "${wanted}" is a draft and cannot be used for a quotation.` };
  return { ok: true, rules };
}
