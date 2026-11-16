import "server-only";
// AUTOMATIC INITIAL PRICING of a Rep draft from Cin7 supplier costs and the Manager's commercial settings. Reads Cin7 with GET only (the read-only gate; no write method exists), then records
// the result through the EXISTING Estimator apply path (applyPricingChange), so the revision lands in newquip_pricing_revisions and the Rep and the Estimator see the same numbers.
// Every price comes out of calculatePricing via createEstimatorPriceSource: there is no second calculator here. Nothing is approved or verified by this: the costs stay "unverified"
// until a Manager independently verifies them, and every approval gate is untouched.
import type { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { TEMPLATE_REVISION_CURRENT, templateRevisionOf } from "@/newquip/grower/commercial";
import { listCin7Suppliers, readRawProductsForSurvey } from "@/lib/projects/latest-cost-adapter";
import { AUTO_ACTOR, autoCostFor, isFlag, mergeAutoEntries, NEUTRAL_FLAG_TEXT, type AutoCostEntry, type AutoFlag } from "@/newquip/pricing/auto-costing";
import { canPriceAnything, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { surveyInputFromRaw } from "@/newquip/pricing/cin7-raw";
import type { MasterSupplier } from "@/newquip/pricing/cost-survey";
import { skuNeedsOf, submissionFrom } from "@/newquip/pricing/estimator";
import type { EstimatorPricing } from "@/newquip/pricing/estimator";
import { SUPPLIER_AUTO_RULE_VERSION } from "@/newquip/pricing/estimator";
import { evaluationContext } from "./context";
import { hasPocFlag } from "./poc-presentation";
import { loadQuote } from "./quote-store";
import { applyPricingChange } from "./pricing-service";
import { latestCommercialSettings } from "./document-store";

type Db = ReturnType<typeof createServiceRoleClient>;
const CHUNK = 12;

export type AutoPricingStatus = "not_applicable" | "settings_incomplete" | "settings_changed" | "nothing_to_add" | "applied" | "no_prices" | "error";
export interface AutoPricingOutcome {
  status: AutoPricingStatus;
  added: number;
  /** DISTINCT neutral texts, safe for a Rep (never a cost, rate, freight or margin). */
  pending: string[];
  /** How many products have no automatic price yet. */
  pendingCount: number;
  /** Internal detail per SKU for a cost-entitled caller only (the action strips it for everyone else). */
  internal: Array<{ sku: string; code: string; text: string }>;
}
const out = (status: AutoPricingStatus, o: Partial<AutoPricingOutcome> = {}): AutoPricingOutcome => ({ status, added: 0, pending: [], pendingCount: 0, internal: [], ...o });
const flagsOutcome = (status: AutoPricingStatus, flags: readonly AutoFlag[], added = 0): AutoPricingOutcome =>
  out(status, { added, pending: [...new Set(flags.map((f) => NEUTRAL_FLAG_TEXT[f.code]))], pendingCount: flags.length, internal: flags.map((f) => ({ sku: f.sku, code: f.code, text: f.internal })) });

/** Auto-pricing owns a quotation's pricing only while NOTHING in it was entered or changed by a person: every cost, the markup and the rule version are the automatic ones. */
export function isAutoOwned(p: EstimatorPricing): boolean {
  if (p.ruleVersionId !== SUPPLIER_AUTO_RULE_VERSION.id) return false;
  if (Object.keys(p.skuPriceOverrides).length > 0 || p.targetAdjustment || Object.keys(p.forwardCover).length > 0) return false;
  if (p.projectMarkup && p.projectMarkup.by !== AUTO_ACTOR) return false;
  return Object.values(p.skus).every((s) => !!s && s.by === AUTO_ACTOR && s.costKind === "cin7_auto");
}
/** The commercial-settings revision an automatic entry was built from (it is written into the entry's source text). */
export function settingsRevisionOf(p: EstimatorPricing): number | null {
  for (const s of Object.values(p.skus)) { const m = s ? /commercial settings v(\d+)/.exec(s.source) : null; if (m) return Number(m[1]); }
  return null;
}

export interface AutoPricingDeps {
  readRaw: (skus: readonly string[]) => Promise<Record<string, { raw: Record<string, unknown> | null } | { error: string }>>;
  suppliers: () => Promise<MasterSupplier[]>;
  now: () => string;
}
export const liveDeps = (db: Db, orgId: string): AutoPricingDeps => ({
  readRaw: (skus) => readRawProductsForSurvey(db, orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, skus),
  suppliers: async () => (await listCin7Suppliers(db, orgId, NEWQUIP_POC_CIN7_INSTANCE_ID)).map((s) => ({ id: s.id, name: s.name, currency: s.currency, active: s.active })),
  now: () => new Date().toISOString(),
});

/**
 * The whole job for ONE quotation. Applies only to a Rep draft of a project quotation on the CURRENT template revision, outside POC presentation mode, whose pricing is either absent or still
 * entirely automatic. Idempotent: it only ever ADDS SKUs that have no entry yet; an existing entry (Estimator-entered or automatic) is never replaced.
 */
export async function runAutoPricing(db: Db, actor: { orgId: string; userId: string }, quoteId: string, deps: AutoPricingDeps = liveDeps(db, actor.orgId)): Promise<AutoPricingOutcome> {
  const q = await loadQuote(db, actor.orgId, quoteId);
  if (!q || q.state !== "REP_DRAFT" || q.draft.quoteType !== "project" || templateRevisionOf(q.draft) !== TEMPLATE_REVISION_CURRENT || hasPocFlag(q.draft)) return out("not_applicable");
  const prior = q.draft.estimator.pricing;
  if (prior && !isAutoOwned(prior)) return out("not_applicable");

  const nowIso = deps.now();
  const stored = await latestCommercialSettings(db, actor.orgId, nowIso);
  const settings: CommercialSettings | null = stored?.settings ?? null;
  if (!stored || !canPriceAnything(settings)) return flagsOutcome("settings_incomplete", [{ sku: "*", code: "settings_incomplete", internal: "The commercial settings are not complete (freight policy not set)." }]);
  if (prior && settingsRevisionOf(prior) !== null && settingsRevisionOf(prior) !== stored.revision) {
    return out("settings_changed", { pending: ["Price pending: commercial settings changed since this quotation was priced; awaiting the Estimator"], internal: [{ sku: "*", code: "settings_changed", text: `Priced under commercial settings v${settingsRevisionOf(prior)}; current is v${stored.revision}.` }] });
  }

  const budget = evaluateDraft(q.draft, evaluationContext(true)).budget;
  const needed = skuNeedsOf(budget).map((n) => n.sku).filter((s) => !prior || !Object.prototype.hasOwnProperty.call(prior.skus, s));
  if (needed.length === 0) return out("nothing_to_add");

  const master = new Map((await deps.suppliers()).map((s) => [s.id, s]));
  const entries: AutoCostEntry[] = [], flags: AutoFlag[] = [];
  for (let i = 0; i < needed.length; i += CHUNK) {
    const part = needed.slice(i, i + CHUNK);
    const reads = await deps.readRaw(part);
    for (const sku of part) {
      const r = reads[sku];
      if (!r || "error" in r) { flags.push({ sku, code: "cost_needs_review", internal: `Cin7 could not be read for this product (${r && "error" in r ? r.error : "no response"}); it will be retried.` }); continue; }
      const res = autoCostFor(surveyInputFromRaw(sku, r.raw), master, settings, { version: stored.revision, enteredBy: stored.enteredBy }, nowIso);
      if (isFlag(res)) flags.push(res); else entries.push(res);
    }
  }
  if (entries.length === 0) return flagsOutcome("no_prices", flags);

  const sub = mergeAutoEntries(prior ? submissionFrom(prior) : null, entries, settings!, { version: stored.revision, enteredBy: stored.enteredBy }, SUPPLIER_AUTO_RULE_VERSION.id);
  const reason = `Automatic pricing from Cin7 supplier costs (commercial settings v${stored.revision}); ${entries.length} product${entries.length === 1 ? "" : "s"}, costs need independent verification`;
  const r = await applyPricingChange(db, { orgId: actor.orgId, userId: actor.userId, email: AUTO_ACTOR, roles: new Set(["estimator"]), canSeeCost: true }, quoteId, sub, reason);
  if (!r.ok) return out("error", { internal: [{ sku: "*", code: "apply_failed", text: r.errors[0] ?? "The automatic pricing could not be recorded." }], pending: ["Price pending"] });
  return flagsOutcome("applied", flags, entries.length);
}
