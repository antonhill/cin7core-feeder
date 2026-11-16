import { TEMPLATE_REVISION_CURRENT, templateRevisionOf } from "@/newquip/grower/commercial";
import type { QuoteDraft } from "@/newquip/grower/draft";

// The template revision is SERVER-OWNED (see draft.ts). Whatever a client sends for it is ignored on every draft write: the STORED value is carried over (absent stays absent = the original
// template), so a save can neither move a quotation to the new template nor hide that it is on the old one. Only createQuote (a NEW quotation) and the explicit, audited adoption action set it.

/** The stored revision wins. `adopting` is passed ONLY by the adoption action, whose submitted draft is built on the server. */
export function keepServerOwnedTemplateRevision<D extends QuoteDraft>(draft: D, prior: Pick<QuoteDraft, "estimator"> | null | undefined, adopting = false): D {
  const next = structuredClone(draft);
  const stored = prior?.estimator?.templateRevision === TEMPLATE_REVISION_CURRENT;
  if (stored || (adopting && draft.estimator.templateRevision === TEMPLATE_REVISION_CURRENT)) next.estimator.templateRevision = TEMPLATE_REVISION_CURRENT; else delete next.estimator.templateRevision;
  return next;
}

/** A NEW quotation is created under the current template (unless it is a POC presentation demonstration, which keeps the original so the demonstration does not move). */
export function stampNewQuotationRevision<D extends QuoteDraft>(draft: D, pocPresentation: boolean): D {
  const next = keepServerOwnedTemplateRevision(draft, null);
  if (!pocPresentation) next.estimator.templateRevision = TEMPLATE_REVISION_CURRENT;
  return next;
}

/**
 * A stale Estimator / Manager tab: the draft it holds was read under a different template revision than the one stored now. A whole-draft save from it would re-apply confirmations made for the other
 * template, so it is refused (nothing written). A Rep is unaffected (the server already replaces every Estimator-owned field from the stored draft). Returns the refusal, or null.
 */
export function staleTemplateRefusal(hasEstimatorAuthority: boolean, client: Pick<QuoteDraft, "estimator">, stored: Pick<QuoteDraft, "estimator"> | null | undefined): string | null {
  if (!stored || !hasEstimatorAuthority || templateRevisionOf(client) === templateRevisionOf(stored)) return null;
  return "This quotation was moved to a different template since you opened it. Reload the page before saving, so nothing you confirmed for the other template is applied.";
}
