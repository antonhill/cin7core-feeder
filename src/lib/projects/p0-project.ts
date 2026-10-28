// Disposable P0 acceptance project (pure). A SEPARATE Toolbox project built for the Cin7 acceptance proofs: real Cin7 SKUs chosen by the
// owner, a small test contract and milestone schedule that are entirely independent of the products' selling values (the products are
// carried at R0 - quantity only). It is never derived from, and never changes, the demonstration quotation or any real project.
import type { ApprovedCommercialBaseline } from "./baseline";
import { randsToCents } from "./claim-engine";
import { scheduleFromPercents, scheduleToStages } from "./variation-schedule";

/** originating_quote_ref prefix that marks a disposable P0 project. */
export const P0_DISPOSABLE_PREFIX = "P0-DISPOSABLE";
export const P0_MAX_PRODUCTS = 2;
export const P0_DEFAULT_CONTRACT_RANDS = "100000";
export const P0_DEFAULT_SCHEDULE = [{ name: "Deposit", percent: "10" }, { name: "Manufacturing", percent: "60" }, { name: "Delivery", percent: "30" }];
/** The 15% VAT rate of the POC (rate only; the Cin7 tax rule NAME is entered separately at Sale creation). */
export const P0_TAX_RATE_BPS = 1500;

export interface P0ProductChoice { sku: string; name: string; quantity: number }
export interface P0ProjectInput {
  /** The dedicated disposable Cin7 customer (exact name). */
  customerName: string;
  products: P0ProductChoice[];
  /** Test contract value, rands ex VAT (text, as typed). */
  contractRands: string;
  schedule: Array<{ name: string; percent: string }>;
}

export function isP0Disposable(ref: string | null | undefined): boolean {
  return (ref ?? "").startsWith(P0_DISPOSABLE_PREFIX);
}

export type P0Plan = { ok: true; baseline: ApprovedCommercialBaseline; stages: Array<{ name: string; valueCents: number }> } | { ok: false; error: string };

/** Validates the owner's choices and builds the project baseline. Fails closed; never defaults a missing product, quantity or amount. */
export function buildP0Baseline(reference: string, input: P0ProjectInput, denylist: readonly string[]): P0Plan {
  const name = input.customerName.trim();
  if (!name) return { ok: false, error: "Enter the dedicated disposable Cin7 customer name." };
  const bad = denylist.find((d) => name.toUpperCase().includes(d.toUpperCase()));
  if (bad) return { ok: false, error: `"${name}" matches the operational customer "${bad}". A dedicated disposable customer is required.` };
  if (input.products.length === 0) return { ok: false, error: "Select at least one existing Cin7 product." };
  if (input.products.length > P0_MAX_PRODUCTS) return { ok: false, error: `A P0 project takes at most ${P0_MAX_PRODUCTS} products.` };
  const seen = new Set<string>();
  for (const p of input.products) {
    if (!p.sku.trim() || seen.has(p.sku)) return { ok: false, error: `SKU ${p.sku || "(blank)"} is missing or selected twice.` };
    seen.add(p.sku);
    if (!Number.isInteger(p.quantity) || p.quantity <= 0) return { ok: false, error: `Quantity for ${p.sku} must be a positive whole number.` };
  }
  let contractCents: number;
  try { contractCents = randsToCents(input.contractRands); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Invalid contract value." }; }
  if (contractCents <= 0) return { ok: false, error: "The test contract value must be greater than zero." };
  let stages;
  try { stages = scheduleToStages(contractCents, scheduleFromPercents(input.schedule)); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Invalid milestone schedule." }; }
  return {
    ok: true,
    stages: stages.map((s) => ({ name: s.name, valueCents: s.valueCents })),
    baseline: {
      sourceQuoteRef: `${P0_DISPOSABLE_PREFIX}-${reference}`, sourceQuoteId: null,
      customer: { cin7CustomerId: null, name },
      currency: "ZAR", contractCents, taxRule: "VAT 15% (P0 disposable)", taxRateBps: P0_TAX_RATE_BPS, taxInclusive: false, salesperson: null,
      // Physical products only: quantity, NO selling value and no cost (the contract is carried by the milestone schedule, not by these lines).
      lines: input.products.map((p, i) => ({ lineRef: `P0-${i + 1}`, sku: p.sku, description: p.name, quantity: p.quantity, salesValueCents: 0, estimatedCostCents: null, suggestedStageName: null })),
      suggestedStages: stages.map((s) => ({ name: s.name, description: `P0 test milestone (${(s.bps / 100).toFixed(2)}%)`, valueCents: s.valueCents })),
      provenance: { kind: "p0_disposable", note: "Disposable acceptance-test project; not derived from any quotation or real project." },
    },
  };
}
