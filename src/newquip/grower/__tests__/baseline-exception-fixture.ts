// Shared test scaffolding for the Manager baseline exception (UX-006 S3).
//
// The golden / demo quotation has three systems with no Cin7 SKU: M75 and penning (Estimator-priced BY DESIGN, so a Manager's baseline exception can cover them) and an LED light
// package that the Estimator merely typed a price for (so it can NOT be covered: it must be mapped). A fixture that wants to get a COSTED demo quotation approved therefore maps the
// LED package in the library (`ledLibraryMapping`) and approves with the Manager's recorded exception (`managerExceptionOpts`).
import type { QuoteRecord } from "@/lib/newquip-quotes/quote-store";

export const LED_MAPPED_SKU = "TEST-FORTIS-LED";
export const FIXTURE_EXCEPTION_REASON = "Fixture: M75 and penning are Estimator-priced by design";

/** An ACTIVE reusable mapping for the LED package (push into the `newquip_package_mappings` table). */
export const ledLibraryMapping = (orgId: string) => ({
  id: "map-led", org_id: orgId, package_key: "led_light", version: 1, status: "ACTIVE" as const,
  lines: [{ sku: LED_MAPPED_SKU, factor: 1, unit: "each", role: "FINISHED_GOOD" as const }],
  reason: "fixture", created_by_email: "fixture@nq", created_at: "2026-01-01T00:00:00.000Z", superseded_at: null,
});

/** The Manager's baseline-exception request for the CURRENT stored version of a quotation (what the Manager workspace sends). */
export const managerExceptionOpts = (q: Pick<QuoteRecord, "revision" | "draft_hash">, reason: string = FIXTURE_EXCEPTION_REASON) =>
  ({ baselineException: { reason, expectedRevision: q.revision, expectedDraftHash: q.draft_hash } });
