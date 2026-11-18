import { GROWER_RULESET_VERSION, GROWER_TEMPLATE } from "../grower/final-feedback";
import { PROJECT_MARKUP_PCT } from "../grower/workbook-price-source";

// THE PRICING RULE SET IN FORCE (NQ-008A). A DESCRIPTOR, not a calculator: it names the rules the existing, unchanged engine applies today so that an
// indicative snapshot can say which rules produced its figures. It reads the existing constants and adds none: no new markup, margin limit, freight or
// installation formula lives here (those are NQ-008B, once NewQuip confirms them). The calculation itself stays in grower/quote-bridge.ts and
// grower/workbook-price-source.ts, untouched. NewQuip-specific by design: nothing here refers to a Spark organisation, billing or infrastructure.

export const PRICING_RULE_SET_ID = "newquip-grower-pricing";

export interface PricingRuleSetDescriptor {
  id: string;
  /** The version of the rules that decide quantities and prices. The same string that is sealed into every accepted baseline. */
  version: string;
  template: { id: string; version: string };
  /** The existing, Sean-confirmed project rule: selling price = landed cost x (1 + this %). */
  projectMarkupPctOnLandedCost: number;
}

export function currentPricingRuleSet(): PricingRuleSetDescriptor {
  return {
    id: PRICING_RULE_SET_ID,
    version: GROWER_RULESET_VERSION,
    template: { id: GROWER_TEMPLATE.id, version: GROWER_TEMPLATE.version },
    projectMarkupPctOnLandedCost: PROJECT_MARKUP_PCT,
  };
}
