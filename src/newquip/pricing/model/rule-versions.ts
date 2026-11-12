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
  maxRateAgeDays: null,
};

// The registry holds ONLY versions a quotation may use. Development fixture versions live in fixtures.ts and are not in it, so they cannot be found, let alone selected.
const REGISTRY: readonly PricingRuleVersion[] = [LEGACY_RULE_VERSION];

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
