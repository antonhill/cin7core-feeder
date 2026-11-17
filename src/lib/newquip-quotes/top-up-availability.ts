import "server-only";
// WHETHER THE ESTIMATOR'S "PRICE FROM CIN7" CAN RUN on a quotation, and if not, exactly why. One rule set, used by BOTH the workspace (so the button is disabled with the reason, never a dead end) and the action itself.
// It is deliberately INDEPENDENT of the automatic Rep-pricing activation flag and cutoff: an authorised Estimator may always read the missing supplier costs from Cin7 (GET only) and price them through the same calculator,
// provided the quotation already carries supplier pricing under the supplier rule set (so no rule, markup or entry a person set is replaced) and the Manager's commercial settings are complete and unchanged.
import type { createServiceRoleClient } from "@/supabase/server";
import { TEMPLATE_REVISION_CURRENT, templateRevisionOf } from "@/newquip/grower/commercial";
import { canPriceAnything, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { SUPPLIER_AUTO_RULE_VERSION, skuNeedsOf, type EstimatorPricing } from "@/newquip/pricing/estimator";
import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import { latestCommercialSettings } from "./document-store";
import { hasPocFlag } from "./poc-presentation";
import type { QuoteRecord } from "./quote-store";

type Db = ReturnType<typeof createServiceRoleClient>;
export interface StoredSettings { revision: number; enteredBy: string; settings: CommercialSettings }
export interface TopUpAvailability { available: boolean; reason: string | null }

/** The commercial-settings revision an automatic entry was built from (it is written into the entry's source text). */
export function settingsRevisionOf(p: EstimatorPricing): number | null {
  for (const s of Object.values(p.skus)) { const m = s ? /commercial settings v(\d+)/.exec(s.source) : null; if (m) return Number(m[1]); }
  return null;
}

export const TOP_UP_STATES = ["REP_DRAFT", "ESTIMATOR_REVIEW"] as const;

/** null = the top-up may run; otherwise the plain-words reason it cannot (shown to the Estimator beside a disabled button). Pure. */
export function topUpIneligibleReason(q: QuoteRecord, stored: StoredSettings | null, budget: BudgetQuote | null | undefined): string | null {
  if (!(TOP_UP_STATES as readonly string[]).includes(q.state)) return "The quotation is no longer with the Rep or the Estimator, so its pricing cannot change.";
  if (q.draft.quoteType !== "project" || templateRevisionOf(q.draft) !== TEMPLATE_REVISION_CURRENT || hasPocFlag(q.draft)) return "Cin7 supplier pricing applies only to project quotations on the current template.";
  const prior = q.draft.estimator.pricing;
  if (!prior || !prior.enabled || prior.ruleVersionId !== SUPPLIER_AUTO_RULE_VERSION.id) return "Supplier pricing has not been started on this quotation under the supplier rule set. Start it first; Price from Cin7 then adds only the missing costs.";
  if (!stored || !canPriceAnything(stored.settings)) return "A Manager must complete the commercial settings (freight policy and exchange rates) before costs can be priced from Cin7.";
  const priced = settingsRevisionOf(prior);
  if (priced !== null && priced !== stored.revision) return `The commercial settings changed (version ${priced} to ${stored.revision}) since this quotation was priced, so new costs cannot be added consistently. A Manager or Estimator must re-price it deliberately.`;
  if (!budget) return "The quotation could not be evaluated, so the products that need a cost are not known.";
  const needed = skuNeedsOf(budget).map((n) => n.sku).filter((s) => !Object.prototype.hasOwnProperty.call(prior.skus, s));
  if (needed.length === 0) return "Every product that needs a supplier cost already has one.";
  return null;
}

export async function cin7TopUpAvailability(db: Db, orgId: string, q: QuoteRecord, budget: BudgetQuote | null | undefined): Promise<TopUpAvailability> {
  let stored: StoredSettings | null = null;
  try { const v = await latestCommercialSettings(db, orgId, new Date().toISOString()); stored = v ? { revision: v.revision, enteredBy: v.enteredBy, settings: v.settings } : null; } catch { stored = null; }
  const reason = topUpIneligibleReason(q, stored, budget);
  return { available: reason === null, reason };
}
