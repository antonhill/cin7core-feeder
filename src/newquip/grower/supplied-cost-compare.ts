import "server-only";
import { SUPPLIED_COSTS } from "./supplied-references";

// Compares a figure Sean / Tereesha SUPPLIED with what Cin7 holds for the same SKU. Pure and read-only: it changes no cost and creates no override. Cin7 stays the primary automatic cost
// authority; a different supplied figure is only a PROPOSED sourced override until its basis and applicable date are established.

export interface Cin7CostFact { cost: number | null; currency: string | null; lastSupplied: string | null; found: boolean }
export type SuppliedComparison =
  | { sku: string; status: "agrees"; supplied: number; cin7: number; note: string }
  | { sku: string; status: "differs"; supplied: number; cin7: number; differencePct: number; note: string }
  | { sku: string; status: "unit_basis_not_reconciled"; supplied: number; cin7: number; note: string }
  | { sku: string; status: "cin7_has_no_cost"; supplied: number; note: string }
  | { sku: string; status: "foreign_currency_not_comparable"; supplied: number; cin7: number; currency: string; note: string }
  | { sku: string; status: "not_in_cin7"; supplied: number; note: string };

const cents = (n: number) => Math.round(n * 100);

export function compareSuppliedCost(sku: string, cin7: Cin7CostFact | undefined): SuppliedComparison {
  const ref = SUPPLIED_COSTS.find((c) => c.sku === sku);
  if (!ref) throw new Error(`No supplied figure is recorded for ${sku}.`);
  const base = { sku, supplied: ref.amountZar };
  if (!cin7 || !cin7.found) return { ...base, status: "not_in_cin7", note: "The product was not found in Cin7: verify the SKU live before using the supplied figure." };
  if (cin7.cost === null) return { ...base, status: "cin7_has_no_cost", note: "Cin7 holds no supplier cost for this product, so the supplied figure is the only reference (a proposed sourced cost, basis unestablished)." };
  if (cin7.currency && cin7.currency !== "ZAR") return { ...base, cin7: cin7.cost, currency: cin7.currency, status: "foreign_currency_not_comparable", note: `Cin7 holds the cost in ${cin7.currency}; the supplied figure is in rand, so they are not compared without an authorised exchange rate.` };
  if (ref.per === "metre") return { ...base, cin7: cin7.cost, status: "unit_basis_not_reconciled", note: "The supplied figure is per METRE; Cin7's unit is Item. The conversion between them is not established, so neither figure is applied or treated as an error." };
  if (cents(cin7.cost) === cents(ref.amountZar)) return { ...base, cin7: cin7.cost, status: "agrees", note: "Agrees with the Cin7 supplier cost: no override is needed." };
  return { ...base, cin7: cin7.cost, status: "differs", differencePct: Math.round(((ref.amountZar - cin7.cost) / cin7.cost) * 10000) / 100, note: "Differs from the Cin7 supplier cost. It stays a proposed sourced override until its basis and applicable date are established; Cin7 is not overwritten." };
}
