import "server-only";
import type { createServiceRoleClient } from "@/supabase/server";
import { hashOf } from "@/newquip/quote/baseline";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { EstimatorPricing } from "@/newquip/pricing/estimator/types";
import { applyPricingSubmission, disablePricing, type PricingChange, type PricingSubmission, type RevisionKind, type Viewer } from "@/newquip/pricing/estimator";
import { loadQuote } from "./quote-store";

// IMMUTABLE ESTIMATOR PRICING REVISIONS (NQ-008B Phase 2, migration 0126). The change and its revision are ONE database transaction (newquip_apply_pricing_revision): a pricing
// change either records who/when/why/rule-version/previous/new or does not happen. Until the migration is applied the function is absent: nothing is written and the caller is
// told so (fail closed: pricing is never changed without its revision).

type Db = ReturnType<typeof createServiceRoleClient>;
const NOT_AVAILABLE = "Estimator pricing revisions are not available yet (database migration pending).";
const notAvailable = (m: string | undefined): boolean => /does not exist|schema cache|could not find the (table|function)|PGRST20[24]/i.test(m ?? "");

export interface PricingRevisionRow {
  id: string; seq: number; quoteRevision: number; kind: RevisionKind; ruleVersion: string; reason: string;
  changes: PricingChange[]; changedBy: string; at: string; newPricingHash: string;
}

export async function listPricingRevisions(db: Db, orgId: string, quoteId: string): Promise<PricingRevisionRow[]> {
  const r = await db.from("newquip_pricing_revisions").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("seq", { ascending: true });
  if (r.error) { if (notAvailable(r.error.message)) return []; throw new Error(r.error.message); }
  return ((r.data ?? []) as Array<Record<string, unknown>>).map((x) => ({
    id: String(x.id), seq: Number(x.seq), quoteRevision: Number(x.quote_revision), kind: x.kind as RevisionKind, ruleVersion: String(x.rule_version), reason: String(x.reason),
    changes: (x.changes as PricingChange[]) ?? [], changedBy: String(x.changed_by_email), at: String(x.created_at), newPricingHash: String(x.new_pricing_hash),
  }));
}

export interface ApplyOutcome { ok: true; seq: number; kind: RevisionKind; changes: PricingChange[]; draftHash: string }
export type ApplyFailure = { ok: false; errors: string[] };

/** Validate, stamp and persist one authorised pricing change as an immutable revision. `submission` null = switch the model off. */
export async function applyEstimatorPricing(
  db: Db, orgId: string, quoteId: string, viewer: Viewer, email: string, submission: PricingSubmission | null, reason: string, nowIso: string = new Date().toISOString(),
): Promise<ApplyOutcome | ApplyFailure> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) return { ok: false, errors: ["Quote not found."] };
  if (q.state === "MANAGER_APPROVED_FINAL") return { ok: false, errors: ["The quotation is approved: its pricing is frozen and cannot be changed."] };
  const prior = q.draft.estimator.pricing;
  const res = submission ? applyPricingSubmission(prior, submission, viewer, email, nowIso, reason, q.draft.quoteType) : disablePricing(prior, viewer, reason);
  if (!res.ok) return res;
  const history = await listPricingRevisions(db, orgId, quoteId);
  const expectedSeq = history.length ? history[history.length - 1].seq : 0;
  const newDraft: QuoteDraft = structuredClone(q.draft);
  if (res.next) newDraft.estimator.pricing = res.next; else delete newDraft.estimator.pricing;
  const newHash = hashOf(newDraft);
  const r = await db.rpc("newquip_apply_pricing_revision", {
    p_org: orgId, p_quote: quoteId, p_expected_seq: expectedSeq, p_expected_draft_hash: q.draft_hash,
    p_new_draft: newDraft, p_new_draft_hash: newHash, p_kind: res.kind, p_reason: reason.trim(), p_rule_version: (res.next ?? prior)!.ruleVersionId,
    p_previous_pricing: prior ?? null, p_new_pricing: res.next, p_changes: res.changes, p_new_pricing_hash: hashOf(res.next ?? { disabled: true }), p_changed_by: email,
  });
  if (r.error) {
    if (/pricing_conflict/i.test(r.error.message)) return { ok: false, errors: ["The quotation or its pricing changed while you were editing; refresh and try again."] };
    if (notAvailable(r.error.message)) return { ok: false, errors: [NOT_AVAILABLE] };
    throw new Error(r.error.message);
  }
  return { ok: true, seq: expectedSeq + 1, kind: res.kind, changes: res.changes, draftHash: newHash };
}
