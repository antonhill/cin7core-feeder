import { PROJECT_MARKUP_PCT } from "../../grower/workbook-price-source";
import type { PricingRuleVersion } from "./types";

// THE RULE-VERSION REGISTRY. Selection is EXPLICIT: nothing selects a version by default except `legacy`, and `draft` versions cannot be selected for a real quotation.
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

/** DEVELOPMENT FIXTURE ONLY. Its figures are placeholders so the model can be exercised; they are NOT NewQuip's rules and the registry refuses to select it for a quotation. */
export const FIXTURE_DRAFT_RULE_VERSION: PricingRuleVersion = {
  id: "fixture-draft-v0",
  label: "Development fixture (not a NewQuip rule)",
  status: "draft",
  markupBps: 2000,
  unverifiedCost: "flag",
  freightUnspecified: "flag",
  maxRateAgeDays: 7,
};

const REGISTRY: readonly PricingRuleVersion[] = [LEGACY_RULE_VERSION, FIXTURE_DRAFT_RULE_VERSION];

/** The version a quotation uses when nobody has explicitly selected another: always the legacy POC rules, so existing prices do not move. */
export const DEFAULT_RULE_VERSION_ID = LEGACY_RULE_VERSION.id;

export type RuleSelection = { ok: true; rules: PricingRuleVersion } | { ok: false; error: string };

export function selectRuleVersion(id: string | null | undefined, opts: { allowDraft?: boolean } = {}): RuleSelection {
  const wanted = id ?? DEFAULT_RULE_VERSION_ID;
  const rules = REGISTRY.find((r) => r.id === wanted);
  if (!rules) return { ok: false, error: `Unknown pricing rule version "${wanted}".` };
  if (rules.status === "draft" && !opts.allowDraft) return { ok: false, error: `Pricing rule version "${wanted}" is a draft and cannot be used for a quotation.` };
  return { ok: true, rules };
}
