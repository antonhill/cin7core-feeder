import "server-only";
// The Estimator pricing workspace and its single write path (NQ-008B Phase 2). Used by the Server Actions in app/newquip-grower/pricing-actions.ts.
import type { createServiceRoleClient } from "@/supabase/server";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { buildPricingWorkspace, canEnterPricingInputs, mayReviewCosts, mayVerifySku, selectRuleVersion, submissionFrom, type PricingSubmission, type PricingWorkspaceView, type VerifyItem, type Viewer } from "@/newquip/pricing/estimator";
import { returnByOf } from "./return-store";
import { reconcileConfirmationAmount, resyncApprovalsLogged, type AmountInvalidation } from "./confirmation-reconcile";
import { latestIndicativeSnapshot } from "./indicative-store";
import { loadQuote } from "./quote-store";
import { applyEstimatorPricing, listPricingRevisions, verifyEstimatorCosts, type PricingRevisionRow } from "./pricing-store";

type Db = ReturnType<typeof createServiceRoleClient>;
export interface PricingActor { orgId: string; userId: string; email: string; roles: ReadonlySet<"rep" | "estimator" | "manager">; canSeeCost: boolean }
export interface WorkspaceBundle { view: PricingWorkspaceView; /** What THIS viewer may do about cost verification: the SKUs they may independently verify now (never ones they entered themselves). */ verification: { canReview: boolean; reviewerRoles: string[]; verifiableSkus: string[] }; /** The stored inputs as the form edits them (null while the model is off). */ current: PricingSubmission | null; revisions: PricingRevisionRow[]; state: string; revision: number; canEdit: boolean }

const viewerOf = (a: PricingActor): Viewer => ({ roles: a.roles, canSeeCost: a.canSeeCost });

/** The workspace for a cost-entitled Estimator/Manager. Anyone else is refused: the data is supplier cost and margin. */
export async function loadPricingWorkspace(db: Db, a: PricingActor, quoteId: string): Promise<WorkspaceBundle> {
  if (!a.canSeeCost || !(a.roles.has("estimator") || a.roles.has("manager"))) throw new Error("Supplier pricing is internal: only an Estimator or Manager who can see costs can open it.");
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  // Cost VISIBLE evaluation of the stored draft; the snapshot supplies the Rep-confirmed original.
  const ev = evaluateDraft(q.draft, evaluationContext(false));
  const snap = await latestIndicativeSnapshot(db, a.orgId, quoteId);
  const view = buildPricingWorkspace({ quoteType: q.draft.quoteType, pricing: q.draft.estimator.pricing, budget: ev.budget, originalTotalCents: snap?.snapshot.customerSafe.subtotalCents ?? null, originalCapturedAt: snap?.created_at ?? null });
  const sel = selectRuleVersion(q.draft.estimator.pricing?.ruleVersionId ?? null);
  const verification = sel.ok
    ? { canReview: mayReviewCosts(viewerOf(a), sel.rules), reviewerRoles: [...sel.rules.costReview.reviewerRoles], verifiableSkus: Object.keys(q.draft.estimator.pricing?.skus ?? {}).filter((k) => mayVerifySku(viewerOf(a), a.email, q.draft.estimator.pricing!.skus[k], sel.rules)).sort() }
    : { canReview: false, reviewerRoles: [], verifiableSkus: [] };
  return { view, verification, current: q.draft.estimator.pricing ? submissionFrom(q.draft.estimator.pricing) : null, revisions: await listPricingRevisions(db, a.orgId, quoteId), state: q.state, revision: q.revision, canEdit: canEnterPricingInputs(viewerOf(a)) && q.state !== "MANAGER_APPROVED_FINAL" };
}

export interface ApplyReport { seq: number; kind: string; changedValues: number; confirmation: AmountInvalidation | null }

/** An independent cost verification: one immutable revision. The Rep's confirmation is untouched (no price moves); the Estimator's sign-off is withdrawn by the write itself. */
export async function verifyCosts(db: Db, a: PricingActor, quoteId: string, items: VerifyItem[], evidence: string): Promise<{ ok: true; report: { seq: number; verified: number } } | { ok: false; errors: string[] }> {
  const out = await verifyEstimatorCosts(db, a.orgId, quoteId, viewerOf(a), a.email, items, evidence);
  if (!out.ok) return out;
  await resyncApprovalsLogged(db, { orgId: a.orgId, userId: a.userId, email: a.email }, quoteId, { returnedToRep: false, signoffCleared: true });
  return { ok: true, report: { seq: out.seq, verified: new Set(items.map((i) => i.sku)).size } };
}

/**
 * Applies (or, with a null submission, switches off) the Estimator pricing as one immutable revision, then runs the SAME confirmation workflow every draft writer runs: if the
 * customer-facing total moved, the Rep's confirmation is withdrawn and the quotation returns to the Rep as a new revision; otherwise only the Estimator's sign-off is
 * withdrawn (the function already did that) and the approval request is re-synced. The Rep-confirmed NQ-008A snapshot is never touched.
 */
export async function applyPricingChange(db: Db, a: PricingActor, quoteId: string, submission: PricingSubmission | null, reason: string): Promise<{ ok: true; report: ApplyReport } | { ok: false; errors: string[] }> {
  const out = await applyEstimatorPricing(db, a.orgId, quoteId, viewerOf(a), a.email, submission, reason);
  if (!out.ok) return out;
  const who = { orgId: a.orgId, userId: a.userId, email: a.email };
  const confirmation = await reconcileConfirmationAmount(db, who, quoteId, evaluationContext(true), returnByOf({ email: a.email, roles: a.roles }, "estimator"));
  if (!confirmation) await resyncApprovalsLogged(db, who, quoteId, { returnedToRep: false, signoffCleared: true });
  return { ok: true, report: { seq: out.seq, kind: out.kind, changedValues: out.changes.length, confirmation } };
}
