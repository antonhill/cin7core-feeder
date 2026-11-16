import { TEMPLATE_REVISION_CURRENT } from "@/newquip/grower/commercial";
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
