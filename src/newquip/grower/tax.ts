// VAT for the budget preview. The existing quote engine (src/lib/quote-margin.ts) owns the tax
// ARITHMETIC; this only decides which RATE to hand it, using the same authority the Quotes module
// uses: the CUSTOMER's Cin7 tax rule, resolved by exact name against Cin7's tax-rule list (/ref/tax).
// No rate is hard-coded here and no rule is guessed by fuzzy name.

export interface TaxRuleLike {
  name: string;
  rate: number;
}

export type VatResolution =
  | { status: "resolved"; ratePct: number; ruleName: string }
  | { status: "no_customer_rule" }
  | { status: "rule_not_found"; ruleName: string };

export function resolveVat(customerTaxRule: string | null | undefined, taxRules: TaxRuleLike[]): VatResolution {
  const name = customerTaxRule?.trim();
  if (!name) return { status: "no_customer_rule" };
  const rule = taxRules.find((r) => r.name === name); // exact — fetchAllTaxRules lists active rules first
  if (!rule || !Number.isFinite(rule.rate)) return { status: "rule_not_found", ruleName: name };
  return { status: "resolved", ratePct: rule.rate, ruleName: rule.name };
}
