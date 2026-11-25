import "server-only";
// AUTOMATIC INITIAL PRICING of a Rep draft from Cin7 supplier costs and the Manager's commercial settings. Reads Cin7 with GET only (the read-only gate; no write method exists), then records
// the result through the EXISTING Estimator apply path (applyPricingChange), so the revision lands in newquip_pricing_revisions and the Rep and the Estimator see the same numbers.
// Every price comes out of calculatePricing via createEstimatorPriceSource: there is no second calculator here. Nothing is approved or verified by this: the costs stay "unverified"
// until a Manager independently verifies them, and every approval gate is untouched.
import type { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { OPTIONAL_ITEM_KEYS } from "@/newquip/grower/types";
import { TEMPLATE_REVISION_CURRENT, templateRevisionOf } from "@/newquip/grower/commercial";
import { listCin7Suppliers, readRawProductsForSurvey } from "@/lib/projects/latest-cost-adapter";
import { AUTO_ACTOR, autoCostFor, isAutoOwned, isFlag, mergeAutoEntries, NEUTRAL_FLAG_TEXT, type AutoCostEntry, type AutoFlag } from "@/newquip/pricing/auto-costing";
import { canPriceAnything, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { surveyInputFromRaw } from "@/newquip/pricing/cin7-raw";
import type { MasterSupplier } from "@/newquip/pricing/cost-survey";
import { skuNeedsOf, submissionFrom, SUPPLIER_AUTO_RULE_VERSION } from "@/newquip/pricing/estimator";
import type { AutoPriceFlag, EstimatorPricing } from "@/newquip/pricing/estimator";
import { evaluationContext } from "./context";
import { hasPocFlag } from "./poc-presentation";
import { loadQuote, type QuoteRecord } from "./quote-store";
import { listPricingRevisions } from "./pricing-store";
import { applyPricingChange } from "./pricing-service";
import { latestCommercialSettings } from "./document-store";
import { settingsRevisionOf, topUpIneligibleReason } from "./top-up-availability";
import { FEED_ACTOR, feedConfigured, refreshFxFromFeed, type FeedOutcome } from "./fx-feed";

type Db = ReturnType<typeof createServiceRoleClient>;
/** Products are read from Cin7 in successive chunks of this size. EVERY product the quotation still needs is read (alphabetical order) until the ONE overall time budget for the run (suppliers + products) is spent; what is unread then is flagged "will be retried". */
export const READ_CHUNK = 12;
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

export { isAutoOwned };
export { settingsRevisionOf };

export interface AutoPricingDeps {
  readRaw: (skus: readonly string[], deadline: number) => Promise<Record<string, { raw: Record<string, unknown> | null } | { error: string }>>;
  suppliers: () => Promise<MasterSupplier[]>;
  now: () => string;
  /** Refreshes a STALE feed-owned exchange rate before pricing (default: the live Open Exchange Rates feed, or "not configured"). Injectable so a test can drive it without a network. */
  refreshFx?: (nowIso: string) => Promise<FeedOutcome>;
}
const NOT_CONFIGURED: FeedOutcome = { ok: false, error: "The Open Exchange Rates feed is not configured for this deployment.", updated: [], keptManual: [], unchanged: [] };
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
/** The deployment's activation facts for the Manager's status display: is the switch on, and is the effective time valid. */
export function activationFacts(env: AutoEnv): { flagOn: boolean; cutoffMs: number | null } {
  const flagOn = env.NEWQUIP_AUTO_PRICING === "on";
  return { flagOn, cutoffMs: flagOn ? autoPricingCutoff(env) : null };
}
export interface AutoActor { orgId: string; userId: string; roles: ReadonlySet<string>; demo: boolean; /** Required for the Estimator top-up (runAutoPricingTopUp): the caller may see cost. */ canSeeCost?: boolean }

/** Every product in `skus` is read, in successive chunks, until `deadline`. A product not reached is simply absent from the result (the caller flags it "will be retried"). Read-only (the adapter's GET-only gate). */
async function readAllChunked(deps: AutoPricingDeps, skus: readonly string[], deadline: number): Promise<Record<string, { raw: Record<string, unknown> | null } | { error: string }>> {
  const all: Record<string, { raw: Record<string, unknown> | null } | { error: string }> = {};
  for (let i = 0; i < skus.length; i += READ_CHUNK) {
    if (Date.now() >= deadline) break;
    Object.assign(all, await deps.readRaw(skus.slice(i, i + READ_CHUNK), deadline));
  }
  return all;
}
const sameFlags = (a: EstimatorPricing["autoFlags"], b: Record<string, AutoPriceFlag>): boolean => {
  const ka = Object.keys(a ?? {}).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a![k]!.code === b[k].code); // the reason CODE only: a different error string must not write a revision (which would withdraw the Estimator's sign-off for no price change)
};

type Mode = "rep" | "estimator";
/** The shared job. `mode` only decides WHO may run it and in which states; every other rule (flag, cutoff, current template, human edits end it, idempotent add-only, fresh re-check inside the write) is identical. */
async function priceQuote(mode: Mode, db: Db, actor: AutoActor, quoteId: string, deps: AutoPricingDeps, env: AutoEnv): Promise<AutoPricingOutcome> {
  const estimator = mode === "estimator";
  const cutoff = autoPricingCutoff(env);
  // The Rep's automatic pricing needs the activation flag and cutoff. The ESTIMATOR's "Price from Cin7" does not: an authorised Estimator may always read the missing supplier costs (see top-up-availability.ts); it says plainly when it cannot.
  const unavailable = (reason: string) => (estimator ? out("not_applicable", { internal: [{ sku: "*", code: "unavailable", text: reason }] }) : out("not_applicable"));
  if (actor.demo || (!estimator && cutoff === null)) return out("not_applicable");
  if (mode === "rep" ? !actor.roles.has("rep") : !(actor.roles.has("estimator") && actor.canSeeCost === true)) return unavailable("Only an Estimator who can see costs can price from Cin7.");
  const started = Date.now();
  const deadline = started + RUN_BUDGET_MS;
  const states = mode === "rep" ? ["REP_DRAFT"] : ["REP_DRAFT", "ESTIMATOR_REVIEW"];
  const q = await loadQuote(db, actor.orgId, quoteId);
  if (!q || !states.includes(q.state) || q.draft.quoteType !== "project" || templateRevisionOf(q.draft) !== TEMPLATE_REVISION_CURRENT || hasPocFlag(q.draft)) return unavailable(q && !states.includes(q.state) ? "The quotation is no longer with the Rep or the Estimator, so its pricing cannot change." : "Cin7 supplier pricing applies only to project quotations on the current template.");
  const prior = q.draft.estimator.pricing;
  if (!estimator) {
    if (!(Date.parse(q.created_at) >= (cutoff as number))) return out("not_applicable");
    const revisions = await listPricingRevisions(db, actor.orgId, quoteId);
    if (prior ? !isAutoOwned(prior) || revisions.some((r) => r.changedBy !== AUTO_ACTOR) : revisions.length > 0) return out("not_applicable");
  }
  const startHash = q.draft_hash;

  const nowIso = deps.now();
  // Exchange rates: if a rate the FEED owns (or a missing USD/EUR rate) has gone stale, fetch fresh ones first (a new FX-only settings version; a Manager's manual override is never replaced; a provider problem leaves the stale rate to be flagged, never used).
  // The outcome is KEPT (it used to be discarded): when a stale rate could not be refreshed, the stored reason for each affected product says why, so the Estimator / Manager can see the real cause.
  const refreshFx = deps.refreshFx ?? ((n: string) => (feedConfigured() ? refreshFxFromFeed(db, actor.orgId, FEED_ACTOR, { onlyIfStale: true, nowIso: n }) : Promise.resolve(NOT_CONFIGURED)));
  const fxRefresh: FeedOutcome = await refreshFx(nowIso).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : "The exchange-rate refresh failed.", updated: [], keptManual: [], unchanged: [] }));
  const stored = await latestCommercialSettings(db, actor.orgId, nowIso);
  const settings: CommercialSettings | null = stored?.settings ?? null;
  if (estimator) {
    const why = topUpIneligibleReason(q, stored ? { revision: stored.revision, epoch: stored.epoch, enteredBy: stored.enteredBy, settings: stored.settings } : null, evaluateDraft(q.draft, evaluationContext(true)).budget);
    if (why) return unavailable(why);
  }
  if (!stored || !canPriceAnything(settings)) return flagsOutcome("settings_incomplete", [{ sku: "*", code: "settings_incomplete", internal: "The commercial settings are not complete (freight policy not set)." }]);
  // The revision the existing entries were priced under is read back from their source text ("commercial settings vN"). A structured field would need a stored-shape change; this is deliberately left as text.
  if (prior && settingsRevisionOf(prior) !== null && (settingsRevisionOf(prior) as number) < stored.epoch) { // only a PRICING-RELEVANT change counts; a refresh of the exchange rates alone does not
    return out("settings_changed", { pending: ["Price pending: commercial settings changed since this quotation was priced; awaiting the Estimator"], internal: [{ sku: "*", code: "settings_changed", text: `Priced under commercial settings v${settingsRevisionOf(prior)}; the pricing-relevant settings last changed at v${stored.epoch}.` }] });
  }

  const budget = evaluateDraft(q.draft, evaluationContext(true)).budget;
  const needsAll = skuNeedsOf(budget);
  const categoriesOf = new Map(needsAll.map((n) => [n.sku, n.itemKeys]));
  // STANDARD equipment is read FIRST. Products are read alphabetically until the run's time budget ends, so a large optional package (sumpless pad cooling adds about 40 SKUs) must never push a standard
  // product (feeder, tank, mat, slats, drinker, light) past the deadline. A SKU used by any standard line goes first; one used only by optional additions goes last. Order within each group is unchanged.
  const optionalOnly = (sku: string): boolean => (categoriesOf.get(sku) ?? []).every((k) => (OPTIONAL_ITEM_KEYS as readonly string[]).includes(k));
  const needed = needsAll.map((n) => n.sku).filter((s) => !prior || !Object.prototype.hasOwnProperty.call(prior.skus, s)).sort((x, y) => Number(optionalOnly(x)) - Number(optionalOnly(y)));
  if (needed.length === 0) return out("nothing_to_add");

  const entries: AutoCostEntry[] = [], flags: AutoFlag[] = [];
  const master = new Map((await deps.suppliers()).map((s) => [s.id, s]));
  const reads = Date.now() < deadline ? await readAllChunked(deps, needed, deadline) : {};
  for (const sku of needed) {
    const r = reads[sku];
    if (!r || "error" in r) { flags.push({ sku, code: "not_read", internal: `Not read from Cin7 in this run (${r && "error" in r ? (r.error === "deadline" ? "out of time" : r.error) : "out of time"}): it will be retried when the quotation is submitted, or use Price from Cin7.` }); continue; }
    const res = autoCostFor(surveyInputFromRaw(sku, r.raw), master, settings, { version: stored.revision, enteredBy: stored.enteredBy }, nowIso, categoriesOf.get(sku) ?? []);
    if (isFlag(res)) flags.push(res.code === "fx_stale" && !fxRefresh.ok ? { ...res, internal: `${res.internal} The automatic rate refresh did not happen: ${fxRefresh.error ?? "unknown reason"}` } : res); else entries.push(res);
  }
  // The specific reason per product is stored WITH the pricing (server-owned, internal; a Rep never receives the pricing) so the Estimator sees exactly why a product has no automatic price. No cost, rate, freight or margin is in it.
  const autoFlags: Record<string, AutoPriceFlag> = Object.fromEntries(flags.filter((f) => f.sku !== "*").map((f) => [f.sku, { code: f.code, internal: f.internal.slice(0, 300), at: nowIso }]));
  if (entries.length === 0 && (!prior || sameFlags(prior.autoFlags, autoFlags))) return flagsOutcome("no_prices", flags); // nothing to record (a quotation with no pricing yet has nowhere to keep the reasons)

  const sub = entries.length > 0 ? mergeAutoEntries(prior ? submissionFrom(prior) : null, entries, settings!, { version: stored.revision, enteredBy: stored.enteredBy }, SUPPLIER_AUTO_RULE_VERSION.id) : submissionFrom(prior!);
  const reason = entries.length > 0
    ? `Automatic pricing from Cin7 supplier costs (commercial settings v${stored.revision}); ${entries.length} product${entries.length === 1 ? "" : "s"}, costs need independent verification`
    : `Automatic pricing: recorded why ${flags.length} product${flags.length === 1 ? " has" : "s have"} no automatic price`;
  // STORED FX: the rate written into the pricing is the settings' rate AS OF its own date, judged fresh against fxMaxAgeDays NOW. It is then frozen with the pricing (the rule version has no age limit and the pricing date is fixed),
  // so a later day does not un-price the quotation; a newer rate only reaches a quotation through a Manager/Estimator change.
  const guard = (cur: QuoteRecord): string | null => (states.includes(cur.state) && cur.draft_hash === startHash && (estimator ? !!cur.draft.estimator.pricing?.enabled && cur.draft.estimator.pricing.ruleVersionId === SUPPLIER_AUTO_RULE_VERSION.id : (!cur.draft.estimator.pricing || isAutoOwned(cur.draft.estimator.pricing))) ? null : GUARD_MSG);
  const r = await applyPricingChange(db, { orgId: actor.orgId, userId: actor.userId, email: AUTO_ACTOR, roles: new Set(["estimator"]), canSeeCost: true }, quoteId, sub, reason, undefined, guard, autoFlags);
  if (!r.ok) {
    if (r.errors[0] === GUARD_MSG) return out("skipped", { internal: [{ sku: "*", code: "skipped", text: GUARD_MSG }] });
    return out("error", { internal: [{ sku: "*", code: "apply_failed", text: r.errors[0] ?? "The automatic pricing could not be recorded." }], pending: ["Price pending"] });
  }
  return flagsOutcome("applied", flags, entries.length);
}

/**
 * The whole job for ONE quotation, and the entry point for a REP (a Rep draft save and the Rep's "Submit to Estimator" hand-off call it; both are gated identically here). It runs only when ALL hold:
 *  - the flag and cutoff are set (autoPricingCutoff), the actor is a real (non-demo) Rep, and the quotation was CREATED on/after the cutoff (existing drafts are never repriced);
 *  - it is a Rep draft of a project quotation on the current template, outside POC presentation mode;
 *  - it has never had pricing changed by a person: no pricing and no revision at all, OR pricing that is entirely automatic whose every revision was made by auto-pricing (a human switch-off,
 *    verification or edit ends it for good: auto-pricing never reverses a person's decision).
 * Idempotent: it only ever ADDS SKUs that have no entry yet. The write re-checks the quotation as freshly loaded INSIDE the write and writes nothing if it changed since the reads (status "skipped").
 */
export function runAutoPricing(db: Db, actor: AutoActor, quoteId: string, deps: AutoPricingDeps = liveDeps(db, actor.orgId), env: AutoEnv = process.env as AutoEnv): Promise<AutoPricingOutcome> {
  return priceQuote("rep", db, actor, quoteId, deps, env);
}

/**
 * The ESTIMATOR's "Price from Cin7": reads the missing supplier costs from Cin7 (GET only) and prices them through the same calculator, ADD-ONLY (every stored entry, review and evidence is kept). It does NOT depend on the automatic Rep-pricing
 * activation flag or cutoff. It runs only while the quotation is with the Rep or in Estimator review, already carries supplier pricing under the supplier rule set, and the Manager's commercial settings are complete and unchanged since
 * (see top-up-availability.ts, which also tells the workspace WHY it is unavailable). The total change goes through the normal pricing path, which withdraws the Rep's confirmation exactly as any pricing change does.
 */
export function runAutoPricingTopUp(db: Db, actor: AutoActor, quoteId: string, deps: AutoPricingDeps = liveDeps(db, actor.orgId), env: AutoEnv = process.env as AutoEnv): Promise<AutoPricingOutcome> {
  return priceQuote("estimator", db, actor, quoteId, deps, env);
}
