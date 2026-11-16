import { TEMPLATE_REVISION_CURRENT } from "../commercial";
import type { QuoteDraft } from "../draft";

/**
 * A clone of the draft stamped with the CURRENT template revision (grower-2026-11): what createQuote does for a NEW quotation. Drafts WITHOUT the stamp (every existing quotation, and the
 * applyDemoDefaults / readyDraft / emptyDraft fixtures) are evaluated against the ORIGINAL template. `estimator.templateRevision` is server-owned; tests stamp it directly.
 */
export function onCurrentTemplate<D extends QuoteDraft>(draft: D): D {
  const c = structuredClone(draft);
  c.estimator.templateRevision = TEMPLATE_REVISION_CURRENT;
  return c;
}
