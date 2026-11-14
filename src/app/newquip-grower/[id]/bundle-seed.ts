import type { BundlePart } from "../actions";
import type { DeliveryView } from "../delivery-actions";
import type { QuoteDocumentsView } from "../document-actions";

// The opening page bundle (getQuotePageBundleAction) hands the approved quotation's delivery status and issued documents to the page's gate and to the Stage 4 / 5 panels, so they do not
// each read them again. A seed is valid for ONE use per consumer (the gate once; a panel once, then it asks the page to drop it), only for the exact quotation version AND viewer it was read for
// (id, last update, linked Project, revision, organisation, the viewer's roles and cost visibility) and only for 30 seconds, measured from the SERVER's read time (`readAt`) and from its arrival
// here (`at`, so a client clock that is behind the server's can never extend it). After that, or after any change, every consumer reads for itself as it always did.
export interface BundleSeed {
  key: string; /** When the bundle arrived in this browser (client clock). */ at: number; /** When the server read the data (server clock, carried in the bundle). */ readAt: number;
  delivery?: BundlePart<DeliveryView>; documents?: BundlePart<QuoteDocumentsView>;
  gateUsed: boolean;
}
export const SEED_MAX_AGE_MS = 30_000;
export const gateKeyOf = (q: { id: string; updated_at: string; project_id: string | null }): string => `${q.id}:${q.updated_at}:${q.project_id ?? ""}`;
/** What a seed is bound to: the quotation version AND the viewer (organisation, roles, cost visibility). A seed produced for anything else is never used. */
export const seedKeyOf = (q: { id: string; updated_at: string; project_id: string | null; revision: number; org_id: string }, v: { roles: readonly string[]; canViewCommercials: boolean }): string =>
  `${gateKeyOf(q)}:r${q.revision}:${q.org_id}:${[...v.roles].sort().join(",")}:${v.canViewCommercials ? "cost" : "nocost"}`;
export const seedFresh = (s: BundleSeed, now: number = Date.now()): boolean => now - s.at < SEED_MAX_AGE_MS && now - s.readAt < SEED_MAX_AGE_MS;
/** The seed a consumer may use: only one bound to exactly this quotation version and viewer (never when the key is unknown). */
export const seedIfBound = (s: BundleSeed | null, key: string): BundleSeed | null => (s && key !== "" && s.key === key ? s : null);
