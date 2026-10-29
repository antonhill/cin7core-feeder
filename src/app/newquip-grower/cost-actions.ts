"use server";

// NewQuip: physical-SKU cost estimate from Cin7 LATEST COST (owner decision for the POC), with audited manual estimates. Cost is internal: every action here needs
// the same permission as the existing cost view (organisation owner/admin), re-established inside EVERY action. Reading Cin7 is a GET of /Product only: nothing
// here writes to Cin7. Costs are stored on the quote's draft by the SERVER (a saved draft can never carry them), and frozen with the approved quotation.
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
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { loadQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { commercialLinesOf } from "@/newquip/quote/baseline";
import { effectiveScope } from "@/lib/projects/product-scope";
import { libraryOf, listActiveMappings } from "@/lib/projects/package-mapping-store";
import { buildCostEstimate, physicalMargin, validateManualEstimate, type CostEntry, type CostEstimate } from "@/lib/projects/latest-cost";
import { readLatestCostEntries } from "@/lib/projects/latest-cost-adapter";
import { rolesFor } from "@/newquip/quote/roles";
import { keepServerOwnedCosts } from "@/newquip/quote/margin";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { applyMappingLibrary } from "@/lib/projects/product-scope";
import { resyncQuoteApprovals, legacyCtx, stagedAvailable } from "@/lib/approvals/approval-store";

export interface CostActionResult<T> { ok: boolean; error?: string; data?: T }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");
const MAX_SKUS = 120;

async function actor() {
  const { orgId } = await requireNewquipPocOrg();
  const access = await requireModuleAccess(QUOTES_MODULE.href);
  let admin = false;
  try { await requireOrgAdmin("see and capture NewQuip costs"); admin = true; } catch { admin = false; } // fail closed
  if (!(await canSeeCosts(createServiceRoleClient(), orgId, access.userId, admin))) throw new Error("Costs are internal: only an organisation owner/admin, or someone given the Estimator or Manager role, can see or capture them.");
  return { orgId, userId: access.userId, email: access.email ?? "unknown" };
}

export interface QuoteCostView {
  estimate: CostEstimate | null; frozen: boolean; contractCents: number | null; marginPct: number | null; gpCents: number | null; complete: boolean;
  note: string; canCapture: boolean; retrievedAt: string | null;
}

async function currentScope(db: ReturnType<typeof createServiceRoleClient>, orgId: string, quoteId: string) {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  const evaluation = evaluateDraft(q.draft, evaluationContext(true));
  const library = await listActiveMappings(db, orgId);
  // The effective scope of the DRAFT with the active reusable mappings applied: the SAME builders approval uses to seal the physical scope.
  const items = evaluation.budget ? buildPhysicalScope(commercialLinesOf(evaluation.budget)) : [];
  const applied = library && library.size ? applyMappingLibrary(items, libraryOf(library), new Date().toISOString()) : items;
  return { q, eff: effectiveScope(applied), contractCents: evaluation.budget ? Math.round(evaluation.budget.totals.subtotalExTax * 100) : null };
}

export async function getQuoteCostEstimateAction(quoteId: string): Promise<CostActionResult<QuoteCostView>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    if (q.state === "MANAGER_APPROVED_FINAL") {
      const e = q.accepted_baseline?.physicalCostEstimate ?? null;
      const contract = q.accepted_baseline?.contractCents ?? null;
      const m = e && contract != null ? physicalMargin(contract, e) : null;
      return { ok: true, data: { estimate: e, frozen: true, contractCents: contract, complete: !!m && m.complete, marginPct: m && m.complete ? m.marginPct : null, gpCents: m && m.complete ? m.gpCents : null,
        note: e ? "Frozen with the approved quotation. Later Cin7 cost changes do not alter it." : "No physical costs were captured before this quotation was approved.", canCapture: false, retrievedAt: e?.lines[0]?.retrievedAt ?? null } };
    }
    const { eff, contractCents, q: live } = await currentScope(db, a.orgId, quoteId);
    const captured = live.draft.estimator.physicalCosts ?? {};
    const estimate = Object.keys(captured).length || eff.lines.length ? buildCostEstimate(eff.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity })), captured, eff.blockers) : null;
    const m = estimate && contractCents != null ? physicalMargin(contractCents, estimate) : null;
    return { ok: true, data: { estimate, frozen: false, contractCents, complete: !!m && m.complete, marginPct: m && m.complete ? m.marginPct : null, gpCents: m && m.complete ? m.gpCents : null,
      note: "Draft estimate. Capture the latest Cin7 costs, then resolve any missing cost before approval.", canCapture: true, retrievedAt: Object.values(captured)[0]?.retrievedAt ?? null } };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

async function writeCosts(db: ReturnType<typeof createServiceRoleClient>, a: Awaited<ReturnType<typeof actor>>, quoteId: string, next: Record<string, CostEntry>, summary: string, action: string, detail: Record<string, unknown>) {
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state === "MANAGER_APPROVED_FINAL") throw new Error("The quotation is approved: its cost estimate is frozen and cannot be changed.");
  const draft = structuredClone(q.draft);
  draft.estimator.physicalCosts = next;
  const saved = await saveDraft(db, a.orgId, rolesFor("admin"), quoteId, keepServerOwnedCosts({ ...draft }, next));
  await logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action, summary: `${summary} (read-only against Cin7)`, detail: { quoteId, ...detail } });
  // Changed content withdraws the estimator's sign-off; the approval request follows the document.
  if (saved.signoffCleared && (await stagedAvailable(db))) await resyncQuoteApprovals(db, legacyCtx(a.orgId, a.userId, a.email, true), quoteId, { quiet: true }).catch(() => undefined);
  return saved;
}

/** Reads the latest Cin7 cost of every physical SKU in the draft's expanded scope and stores it (with its source and retrieval time). Manual estimates are kept. */
export async function captureLatestCostsAction(quoteId: string): Promise<CostActionResult<{ captured: number; missing: string[] }>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const { q, eff } = await currentScope(db, a.orgId, quoteId);
    if (eff.lines.length > MAX_SKUS) throw new Error(`This quotation expands to ${eff.lines.length} SKUs; capture is limited to ${MAX_SKUS} per run.`);
    const now = new Date().toISOString();
    const next: Record<string, CostEntry> = {};
    for (const [sku, e] of Object.entries(q.draft.estimator.physicalCosts ?? {})) if (e.source === "MANUAL_ESTIMATE" && eff.lines.some((l) => l.sku === sku)) next[sku] = e; // a manual estimate is never overwritten by a refresh
    const read = await readLatestCostEntries(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, eff.lines.map((l) => l.sku).filter((sku) => !next[sku]), now);
    Object.assign(next, read);
    const missing = Object.entries(read).filter(([, e]) => e.unitCostCents === null).map(([sku]) => sku);
    await writeCosts(db, a, quoteId, next, "Captured the latest Cin7 costs for a NewQuip quotation", "newquip.latest_costs_captured", { skus: eff.lines.length, missing: missing.length });
    return { ok: true, data: { captured: eff.lines.length - missing.length, missing } };
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
    await writeCosts(db, a, quoteId, next, "Recorded a manual cost estimate for a NewQuip quotation", "newquip.manual_cost_estimate", { sku, reason: reason.trim() });
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
    await writeCosts(db, a, quoteId, next, "Removed a manual cost estimate from a NewQuip quotation", "newquip.manual_cost_estimate_removed", { sku });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}
