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
import { loadQuote, type QuoteRecord } from "./quote-store";
import { listPricingRevisions } from "./pricing-store";
import { applyPricingChange } from "./pricing-service";
import { latestCommercialSettings } from "./document-store";

type Db = ReturnType<typeof createServiceRoleClient>;
/** The most products read from Cin7 in ONE run, and the one overall time budget for the whole run (suppliers + products), so a Rep's save can never wait much more than this. */
export const MAX_SKUS_PER_RUN = 12;
export const RUN_BUDGET_MS = 40_000;
const GUARD_MSG = "The quotation changed while its costs were being read, so automatic pricing was skipped.";

export type AutoPricingStatus = "skipped" | "not_applicable" | "settings_incomplete" | "settings_changed" | "nothing_to_add" | "applied" | "no_prices" | "error";
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
  readRaw: (skus: readonly string[], deadline: number) => Promise<Record<string, { raw: Record<string, unknown> | null } | { error: string }>>;
  suppliers: () => Promise<MasterSupplier[]>;
  now: () => string;
}
export const liveDeps = (db: Db, orgId: string): AutoPricingDeps => ({
  readRaw: (skus, deadline) => readRawProductsForSurvey(db, orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, skus, deadline),
  suppliers: async () => (await listCin7Suppliers(db, orgId, NEWQUIP_POC_CIN7_INSTANCE_ID)).map((s) => ({ id: s.id, name: s.name, currency: s.currency, active: s.active })),
  now: () => new Date().toISOString(),
});

export type AutoEnv = Record<string, string | undefined>;
/** Automatic pricing is ON only when NEWQUIP_AUTO_PRICING is "on" AND NEWQUIP_AUTO_PRICING_FROM is a valid ISO timestamp (the cutoff). Returns the cutoff in ms, or null = OFF. */
export function autoPricingCutoff(env: AutoEnv): number | null {
  if (env.NEWQUIP_AUTO_PRICING !== "on") return null;
  const f = env.NEWQUIP_AUTO_PRICING_FROM;
  const t = typeof f === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(f) ? Date.parse(f) : NaN; // a timezone (Z or an offset) is REQUIRED: no server-local interpretation
  return Number.isFinite(t) ? t : null;
}
export interface AutoActor { orgId: string; userId: string; roles: ReadonlySet<string>; demo: boolean }

/**
 * The whole job for ONE quotation, and the ONLY entry point (every caller is gated identically here). It runs only when ALL hold:
 *  - the flag and cutoff are set (autoPricingCutoff), the actor is a real (non-demo) Rep, and the quotation was CREATED on/after the cutoff (existing drafts are never repriced);
 *  - it is a Rep draft of a project quotation on the current template, outside POC presentation mode;
 *  - it has never had pricing changed by a person: no pricing and no revision at all, OR pricing that is entirely automatic whose every revision was made by auto-pricing (a human switch-off,
 *    verification or edit ends it for good: auto-pricing never reverses a person's decision).
 * Idempotent: it only ever ADDS SKUs that have no entry yet. The write re-checks the quotation as freshly loaded INSIDE the write and writes nothing if it changed since the reads (status "skipped").
 */
export async function runAutoPricing(db: Db, actor: AutoActor, quoteId: string, deps: AutoPricingDeps = liveDeps(db, actor.orgId), env: AutoEnv = process.env as AutoEnv): Promise<AutoPricingOutcome> {
  const cutoff = autoPricingCutoff(env);
  if (cutoff === null || actor.demo || !actor.roles.has("rep")) return out("not_applicable");
  const started = Date.now();
  const deadline = started + RUN_BUDGET_MS;
  const q = await loadQuote(db, actor.orgId, quoteId);
  if (!q || q.state !== "REP_DRAFT" || q.draft.quoteType !== "project" || templateRevisionOf(q.draft) !== TEMPLATE_REVISION_CURRENT || hasPocFlag(q.draft)) return out("not_applicable");
  if (!(Date.parse(q.created_at) >= cutoff)) return out("not_applicable");
  const prior = q.draft.estimator.pricing;
  const revisions = await listPricingRevisions(db, actor.orgId, quoteId);
  if (prior ? !isAutoOwned(prior) || revisions.some((r) => r.changedBy !== AUTO_ACTOR) : revisions.length > 0) return out("not_applicable");
  const startHash = q.draft_hash;

  const nowIso = deps.now();
  const stored = await latestCommercialSettings(db, actor.orgId, nowIso);
  const settings: CommercialSettings | null = stored?.settings ?? null;
  if (!stored || !canPriceAnything(settings)) return flagsOutcome("settings_incomplete", [{ sku: "*", code: "settings_incomplete", internal: "The commercial settings are not complete (freight policy not set)." }]);
  // The revision the existing entries were priced under is read back from their source text ("commercial settings vN"). A structured field would need a stored-shape change; this is deliberately left as text.
  if (prior && settingsRevisionOf(prior) !== null && settingsRevisionOf(prior) !== stored.revision) {
    return out("settings_changed", { pending: ["Price pending: commercial settings changed since this quotation was priced; awaiting the Estimator"], internal: [{ sku: "*", code: "settings_changed", text: `Priced under commercial settings v${settingsRevisionOf(prior)}; current is v${stored.revision}.` }] });
  }

  const budget = evaluateDraft(q.draft, evaluationContext(true)).budget;
  const missing = skuNeedsOf(budget).map((n) => n.sku).filter((s) => !prior || !Object.prototype.hasOwnProperty.call(prior.skus, s));
  if (missing.length === 0) return out("nothing_to_add");
  const needed = missing.slice(0, MAX_SKUS_PER_RUN);

  const entries: AutoCostEntry[] = [], flags: AutoFlag[] = [];
  for (const sku of missing.slice(MAX_SKUS_PER_RUN)) flags.push({ sku, code: "cost_needs_review", internal: "Not read from Cin7 in this run (at most " + MAX_SKUS_PER_RUN + " products per save); it is picked up on a later save." });
  const master = new Map((await deps.suppliers()).map((s) => [s.id, s]));
  const reads = Date.now() < deadline ? await deps.readRaw(needed, deadline) : {};
  for (const sku of needed) {
    const r = reads[sku];
    if (!r || "error" in r) { flags.push({ sku, code: "cost_needs_review", internal: `Cin7 could not be read for this product (${r && "error" in r ? r.error : "out of time"}); it will be retried.` }); continue; }
    const res = autoCostFor(surveyInputFromRaw(sku, r.raw), master, settings, { version: stored.revision, enteredBy: stored.enteredBy }, nowIso);
    if (isFlag(res)) flags.push(res); else entries.push(res);
  }
  if (entries.length === 0) return flagsOutcome("no_prices", flags);

  const sub = mergeAutoEntries(prior ? submissionFrom(prior) : null, entries, settings!, { version: stored.revision, enteredBy: stored.enteredBy }, SUPPLIER_AUTO_RULE_VERSION.id);
  const reason = `Automatic pricing from Cin7 supplier costs (commercial settings v${stored.revision}); ${entries.length} product${entries.length === 1 ? "" : "s"}, costs need independent verification`;
  // STORED FX: the rate written into the pricing is the settings' rate AS OF its own date, judged fresh against fxMaxAgeDays NOW. It is then frozen with the pricing (the rule version has no age limit and the pricing date is fixed),
  // so a later day does not un-price the quotation; a newer rate only reaches a quotation through a Manager/Estimator change.
  const guard = (cur: QuoteRecord): string | null => (cur.state === "REP_DRAFT" && cur.draft_hash === startHash && (!cur.draft.estimator.pricing || isAutoOwned(cur.draft.estimator.pricing)) ? null : GUARD_MSG);
  const r = await applyPricingChange(db, { orgId: actor.orgId, userId: actor.userId, email: AUTO_ACTOR, roles: new Set(["estimator"]), canSeeCost: true }, quoteId, sub, reason, undefined, guard);
  if (!r.ok) {
    if (r.errors[0] === GUARD_MSG) return out("skipped", { internal: [{ sku: "*", code: "skipped", text: GUARD_MSG }] });
    return out("error", { internal: [{ sku: "*", code: "apply_failed", text: r.errors[0] ?? "The automatic pricing could not be recorded." }], pending: ["Price pending"] });
  }
  return flagsOutcome("applied", flags, entries.length);
}
