"use server";

// NewQuip: physical-SKU cost estimate from Cin7 LATEST SUPPLIER PRICES, across every supplier of a SKU, in ZAR. Cost is internal: every action here needs the same
// permission as the existing cost view (owner/admin, or an explicit Estimator / Manager), re-established inside EVERY action; none is available while a Demo Mode
// identity is active. Reading Cin7 is a GET of /Product only: nothing here writes to Cin7. Costs, the selection among suppliers and the cost-basis declarations are
// stored on the quote's draft by the SERVER (a saved draft can never carry them) and frozen with the approved quotation.
// Only async functions and erased types are exported.
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { canSeeCosts } from "@/lib/approvals/role-store";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { loadQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { effectiveScope, applyMappingLibrary } from "@/lib/projects/product-scope";
import { libraryOf, listActiveMappings } from "@/lib/projects/package-mapping-store";
import { buildCostEstimate, buildSupplierCostEntry, physicalMargin, reevaluateEntry, validateManualEstimate, type CostEntry, type CostEstimate } from "@/lib/projects/latest-cost";
import { readSupplierPrices } from "@/lib/projects/latest-cost-adapter";
import { currentRates, recordRate, rateHistory, type FxRow } from "@/lib/projects/fx-store";
import { DEFAULT_MAX_RATE_AGE_HOURS, selectionNeedsReason, type ChosenSupplier, type FxRate, type NormaliseEnv, type SelectionStatus, type SupplierOption, type UnitBasis } from "@/lib/projects/supplier-price";
import { rolesFor } from "@/newquip/quote/roles";
import { keepServerOwnedCostBasis, keepServerOwnedCosts } from "@/newquip/quote/margin";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { commercialLinesOf } from "@/newquip/quote/baseline";
import { resyncQuoteApprovals, legacyCtx, stagedAvailable } from "@/lib/approvals/approval-store";

export interface CostActionResult<T> { ok: boolean; error?: string; data?: T }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");
const MAX_SKUS = 120;
type Db = ReturnType<typeof createServiceRoleClient>;
type CostBasis = NonNullable<QuoteDraft["estimator"]["costBasis"]>;

async function actor() {
  const { orgId } = await requireNewquipPocOrg();
  const access = await requireModuleAccess(QUOTES_MODULE.href);
  let admin = false;
  try { await requireOrgAdmin("see and capture NewQuip costs"); admin = true; } catch { admin = false; } // fail closed
  if (!(await canSeeCosts(createServiceRoleClient(), orgId, access.userId, admin))) throw new Error("Costs are internal: only an organisation owner/admin, or someone given the Estimator or Manager role, can see or capture them.");
  return { orgId, userId: access.userId, email: access.email ?? "unknown" };
}
type Actor = Awaited<ReturnType<typeof actor>>;

export interface SkuOptionsView {
  options: SupplierOption[]; selection: ChosenSupplier | null; selectionStatus: SelectionStatus | null; message: string | null;
  /** The stored cost no longer matches a re-evaluation under today's exchange rates / declarations. */
  needsRecalculation: boolean;
}
export interface QuoteCostView {
  estimate: CostEstimate | null; frozen: boolean; contractCents: number | null; marginPct: number | null; gpCents: number | null; complete: boolean;
  note: string; canCapture: boolean; retrievedAt: string | null;
  skuOptions: Record<string, SkuOptionsView>;
  fx: Record<string, FxRate>; fxAvailable: boolean; fxHistory: FxRow[]; maxRateAgeHours: number;
  unitBasis: UnitBasis | null; incompleteAccepted: { reason: string; by: string; at: string } | null;
}

async function costEnv(db: Db, orgId: string, basis: CostBasis | undefined, nowIso: string): Promise<{ env: NormaliseEnv; fxAvailable: boolean }> {
  const rates = await currentRates(db, orgId);
  return { env: { fx: rates ?? {}, nowIso, maxRateAgeHours: DEFAULT_MAX_RATE_AGE_HOURS, unitBasis: basis?.unitBasis ?? null }, fxAvailable: rates !== null };
}

async function currentScope(db: Db, orgId: string, quoteId: string) {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  const evaluation = evaluateDraft(q.draft, evaluationContext(true));
  const library = await listActiveMappings(db, orgId);
  // The effective scope of the DRAFT with the active reusable mappings applied: the SAME builders approval uses to seal the physical scope.
  const items = evaluation.budget ? buildPhysicalScope(commercialLinesOf(evaluation.budget)) : [];
  const applied = library && library.size ? applyMappingLibrary(items, libraryOf(library), new Date().toISOString()) : items;
  return { q, eff: effectiveScope(applied), contractCents: evaluation.budget ? Math.round(evaluation.budget.totals.subtotalExTax * 100) : null };
}

const sameCost = (a: CostEntry, b: CostEntry) => a.unitCostCents === b.unitCostCents && a.selectionStatus === b.selectionStatus && (a.selection?.supplierName ?? null) === (b.selection?.supplierName ?? null);

export async function getQuoteCostEstimateAction(quoteId: string): Promise<CostActionResult<QuoteCostView>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const nowIso = new Date().toISOString();
    const fxRows = await rateHistory(db, a.orgId, 20);
    const { env, fxAvailable } = await costEnv(db, a.orgId, q.draft.estimator.costBasis, nowIso);
    const common = { fx: env.fx as Record<string, FxRate>, fxAvailable, fxHistory: fxRows, maxRateAgeHours: env.maxRateAgeHours, unitBasis: q.draft.estimator.costBasis?.unitBasis ?? null, incompleteAccepted: q.draft.estimator.costBasis?.incompleteAccepted ?? null };
    if (q.state === "MANAGER_APPROVED_FINAL") {
      const e = q.accepted_baseline?.physicalCostEstimate ?? null;
      const contract = q.accepted_baseline?.contractCents ?? null;
      const m = e && contract != null ? physicalMargin(contract, e) : null;
      return { ok: true, data: { estimate: e, frozen: true, contractCents: contract, complete: !!m && m.complete, marginPct: m && m.complete ? m.marginPct : null, gpCents: m && m.complete ? m.gpCents : null,
        note: e ? "Frozen with the approved quotation. Later Cin7 prices and exchange rates do not alter it." : "No physical costs were captured before this quotation was approved.", canCapture: false, retrievedAt: e?.lines[0]?.retrievedAt ?? null, skuOptions: {}, ...common,
        unitBasis: (e?.costBasis?.unitBasis as UnitBasis | undefined) ?? null, incompleteAccepted: e?.costBasis?.incompleteAccepted ?? null } };
    }
    const { eff, contractCents, q: live } = await currentScope(db, a.orgId, quoteId);
    const captured = live.draft.estimator.physicalCosts ?? {};
    const skuOptions: Record<string, SkuOptionsView> = {};
    for (const [sku, entry] of Object.entries(captured)) {
      if (!entry.options) continue;
      const fresh = reevaluateEntry(entry, env, nowIso);
      skuOptions[sku] = { options: fresh.options!, selection: fresh.selection ?? null, selectionStatus: fresh.selectionStatus ?? null, message: fresh.selectionMessage ?? null, needsRecalculation: !sameCost(entry, fresh) };
    }
    const estimate = Object.keys(captured).length || eff.lines.length ? buildCostEstimate(eff.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity })), captured, eff.blockers) : null;
    const m = estimate && contractCents != null ? physicalMargin(contractCents, estimate) : null;
    return { ok: true, data: { estimate, frozen: false, contractCents, complete: !!m && m.complete, marginPct: m && m.complete ? m.marginPct : null, gpCents: m && m.complete ? m.gpCents : null,
      note: "Draft estimate. Capture the supplier prices, select a supplier where asked, and resolve any missing cost before approval.", canCapture: true, retrievedAt: Object.values(captured)[0]?.retrievedAt ?? null, skuOptions, ...common } };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** One audited draft write. The draft changes, so the estimator's sign-off is withdrawn and the approval request follows the document. */
async function writeDraftCosts(db: Db, a: Actor, quoteId: string, next: { physicalCosts?: Record<string, CostEntry>; costBasis?: CostBasis | undefined }, summary: string, action: string, detail: Record<string, unknown>) {
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state === "MANAGER_APPROVED_FINAL") throw new Error("The quotation is approved: its cost estimate is frozen and cannot be changed.");
  const draft = structuredClone(q.draft);
  const physicalCosts = next.physicalCosts ?? draft.estimator.physicalCosts;
  const costBasis = "costBasis" in next ? next.costBasis : draft.estimator.costBasis;
  const saved = await saveDraft(db, a.orgId, rolesFor("admin"), quoteId, keepServerOwnedCostBasis(keepServerOwnedCosts(draft, physicalCosts), costBasis));
  await logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action, summary: `${summary} (read-only against Cin7)`, detail: { quoteId, ...detail } });
  if (saved.signoffCleared && (await stagedAvailable(db))) await resyncQuoteApprovals(db, legacyCtx(a.orgId, a.userId, a.email, true), quoteId, { quiet: true }).catch(() => undefined);
  return saved;
}

/**
 * Reads EVERY supplier price of each physical SKU from Cin7 and builds the cost options. A deliberate estimator selection and any manual estimate are kept unless
 * `replaceSelections` is passed (an explicit user action); the newest date never decides, and the cheapest is never chosen.
 */
export async function captureLatestCostsAction(quoteId: string, opts: { replaceSelections?: boolean } = {}): Promise<CostActionResult<{ captured: number; missing: string[]; needsChoice: string[] }>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const { q, eff } = await currentScope(db, a.orgId, quoteId);
    if (eff.lines.length > MAX_SKUS) throw new Error(`This quotation expands to ${eff.lines.length} SKUs; capture is limited to ${MAX_SKUS} per run.`);
    const now = new Date().toISOString();
    const { env } = await costEnv(db, a.orgId, q.draft.estimator.costBasis, now);
    const prior = q.draft.estimator.physicalCosts ?? {};
    const next: Record<string, CostEntry> = {};
    for (const [sku, e] of Object.entries(prior)) if (e.source === "MANUAL_ESTIMATE" && eff.lines.some((l) => l.sku === sku)) next[sku] = e; // an audited manual estimate is never overwritten by a refresh
    const skus = eff.lines.map((l) => l.sku).filter((sku) => !next[sku]);
    const prices = await readSupplierPrices(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, skus);
    for (const sku of skus) next[sku] = buildSupplierCostEntry({ raws: prices[sku]?.raws ?? [], env, prior: prior[sku], replaceSelection: !!opts.replaceSelections, nowIso: now });
    await writeDraftCosts(db, a, quoteId, { physicalCosts: next }, "Captured the Cin7 supplier prices for a NewQuip quotation", "newquip.supplier_prices_captured", { skus: eff.lines.length, replaceSelections: !!opts.replaceSelections });
    const entries = skus.map((s) => [s, next[s]] as const);
    return { ok: true, data: { captured: entries.filter(([, e]) => e.unitCostCents !== null).length, missing: entries.filter(([, e]) => e.selectionStatus === "MISSING").map(([s]) => s), needsChoice: entries.filter(([, e]) => e.selectionStatus === "NEEDS_CHOICE" || e.selectionStatus === "PREFERRED_INVALID").map(([s]) => s) } };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** The estimator chooses the supplier among the options already captured. Only stored, currently usable options can be chosen; changing a choice, or choosing against the preference, needs a reason. */
export async function selectSupplierAction(quoteId: string, sku: string, supplier: { supplierId: string | null; supplierName: string | null }, reason?: string): Promise<CostActionResult<null>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const entry = q.draft.estimator.physicalCosts?.[sku];
    if (!entry || !entry.options) throw new Error(`${sku} has no captured supplier prices: capture the Cin7 prices first.`);
    const now = new Date().toISOString();
    const { env } = await costEnv(db, a.orgId, q.draft.estimator.costBasis, now);
    const fresh = reevaluateEntry(entry, env, now);
    const opt = fresh.options!.find((o) => (supplier.supplierId !== null ? o.supplierId === supplier.supplierId : o.supplierName === supplier.supplierName));
    if (!opt) throw new Error("That supplier is not one of the captured options for this SKU.");
    if (opt.status !== "USABLE") throw new Error(`That supplier's price cannot be used: ${opt.problems.filter((p) => p.blocking).map((p) => p.message).join(" ")}`);
    const needsReason = selectionNeedsReason(entry.selection, supplier, fresh.options!);
    if (needsReason && (reason ?? "").trim().length < 5) throw new Error("A reason is required to change the supplier or to choose against the preferred supplier.");
    const choice: ChosenSupplier = { supplierId: opt.supplierId, supplierName: opt.supplierName, method: "MANUAL_SELECTION", ...(reason?.trim() ? { reason: reason.trim() } : {}), by: a.email, at: now };
    const updated = reevaluateEntry(entry, env, now, choice);
    await writeDraftCosts(db, a, quoteId, { physicalCosts: { ...(q.draft.estimator.physicalCosts ?? {}), [sku]: updated } }, "Selected the supplier for a NewQuip cost line", "newquip.supplier_selected", { sku, supplier: opt.supplierName, supplierId: opt.supplierId, reason: reason?.trim() ?? null, previous: entry.selection?.supplierName ?? null });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** Re-evaluates every captured option under today's exchange rates and declarations (no Cin7 read), keeping deliberate selections that are still usable. */
export async function recalculateCostsAction(quoteId: string): Promise<CostActionResult<null>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const now = new Date().toISOString();
    const { env } = await costEnv(db, a.orgId, q.draft.estimator.costBasis, now);
    const costs = q.draft.estimator.physicalCosts ?? {};
    const next = Object.fromEntries(Object.entries(costs).map(([sku, e]) => [sku, e.options ? reevaluateEntry(e, env, now) : e]));
    await writeDraftCosts(db, a, quoteId, { physicalCosts: next }, "Recalculated a NewQuip cost estimate under the current exchange rates", "newquip.costs_recalculated", {});
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** Records an exchange-rate snapshot (ZAR per 1 unit of a foreign currency). Audited and append-only; it never changes an existing quotation by itself. */
export async function recordFxRateAction(currency: string, rate: string, source: string, asOfIso: string): Promise<CostActionResult<null>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    await recordRate(db, { canSeeCost: true }, a.email, { orgId: a.orgId, currency, rate, source, asOf: asOfIso });
    await logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.fx_rate_recorded", summary: `Recorded the ${currency.trim().toUpperCase()} exchange rate`, detail: { currency: currency.trim().toUpperCase(), rate, source, asOf: asOfIso } });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** The estimator declares that NewQuip's Cin7 supplier prices are per stock unit (Cin7 does not state a purchase unit). Audited; prices stay unusable until someone declares it. */
export async function confirmUnitBasisAction(quoteId: string, reason: string): Promise<CostActionResult<null>> {
  try {
    const a = await actor();
    if (reason.trim().length < 10) throw new Error("Explain how you know the supplier prices are per stock unit (at least a short sentence).");
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const now = new Date().toISOString();
    const basis: CostBasis = { ...(q.draft.estimator.costBasis ?? {}), unitBasis: { basis: "STOCK_UNIT", confirmedBy: a.email, confirmedAt: now, reason: reason.trim() } };
    const { env } = await costEnv(db, a.orgId, basis, now);
    const costs = q.draft.estimator.physicalCosts ?? {};
    const next = Object.fromEntries(Object.entries(costs).map(([sku, e]) => [sku, e.options ? reevaluateEntry(e, env, now) : e]));
    await writeDraftCosts(db, a, quoteId, { physicalCosts: next, costBasis: basis }, "Confirmed that supplier prices are per stock unit for a NewQuip quotation", "newquip.unit_basis_confirmed", { reason: reason.trim() });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** An authorised exception: lets a quotation with an incomplete cost estimate be approved. Reasoned, audited, and frozen with the approval. */
export async function acceptIncompleteCostsAction(quoteId: string, reason: string): Promise<CostActionResult<null>> {
  try {
    const a = await actor();
    if (reason.trim().length < 10) throw new Error("An exception needs a written reason (at least a short sentence).");
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const now = new Date().toISOString();
    await writeDraftCosts(db, a, quoteId, { costBasis: { ...(q.draft.estimator.costBasis ?? {}), incompleteAccepted: { reason: reason.trim(), by: a.email, at: now } } }, "Accepted an incomplete cost estimate for a NewQuip quotation", "newquip.incomplete_costs_accepted", { reason: reason.trim() });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** An audited manual cost estimate for ONE SKU (reason required). It stands in for a missing Cin7 cost and is shown as MANUAL, never as a Cin7 cost. */
export async function setManualCostEstimateAction(quoteId: string, sku: string, unitCostCents: number, reason: string): Promise<CostActionResult<null>> {
  try {
    const a = await actor();
    const bad = validateManualEstimate(unitCostCents, reason);
    if (bad) throw new Error(bad);
    const db = createServiceRoleClient();
    const { q, eff } = await currentScope(db, a.orgId, quoteId);
    if (!eff.lines.some((l) => l.sku === sku)) throw new Error(`${sku} is not a physical SKU of this quotation.`);
    const now = new Date().toISOString();
    const next = { ...(q.draft.estimator.physicalCosts ?? {}), [sku]: { unitCostCents, source: "MANUAL_ESTIMATE", retrievedAt: now, reason: reason.trim(), by: a.email, at: now } as CostEntry };
    await writeDraftCosts(db, a, quoteId, { physicalCosts: next }, "Recorded a manual cost estimate for a NewQuip quotation", "newquip.manual_cost_estimate", { sku, reason: reason.trim() });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** Removes a manual estimate (the SKU is then missing a cost again until Cin7 is re-read). */
export async function clearManualCostEstimateAction(quoteId: string, sku: string): Promise<CostActionResult<null>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const cur = q.draft.estimator.physicalCosts ?? {};
    if (cur[sku]?.source !== "MANUAL_ESTIMATE") throw new Error("There is no manual estimate for that SKU.");
    const next = { ...cur }; delete next[sku];
    await writeDraftCosts(db, a, quoteId, { physicalCosts: next }, "Removed a manual cost estimate from a NewQuip quotation", "newquip.manual_cost_estimate_removed", { sku });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}
