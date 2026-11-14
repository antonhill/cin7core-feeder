import type { BundlePart } from "../actions";
import type { DeliveryView } from "../delivery-actions";
import type { QuoteDocumentsView } from "../document-actions";

// The opening page bundle (getQuotePageBundleAction) hands the approved quotation's delivery status and issued documents to the page's gate and to the Stage 4 / 5 panels, so they do not
// each read them again. A seed is valid for ONE use per consumer (the gate once; a panel once, then it asks the page to drop it), only for the exact quotation version it was read for (id, last update, linked Project) and only for a minute: after
// that, or after any change, every consumer reads for itself as it always did.
export interface BundleSeed {
  key: string; at: number;
  delivery?: BundlePart<DeliveryView>; documents?: BundlePart<QuoteDocumentsView>;
  gateUsed: boolean;
}
export const SEED_MAX_AGE_MS = 60_000;
export const gateKeyOf = (q: { id: string; updated_at: string; project_id: string | null }): string => `${q.id}:${q.updated_at}:${q.project_id ?? ""}`;
export const seedFresh = (s: BundleSeed, now: number = Date.now()): boolean => now - s.at < SEED_MAX_AGE_MS;
