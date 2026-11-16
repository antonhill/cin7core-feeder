// Shared test scaffolding for the Manager baseline exception (UX-006 S3).
//
// The golden / demo quotation has two systems with no Cin7 SKU: M75 and penning (Estimator-priced BY DESIGN, so a Manager's baseline exception can cover them). The LED light package is
// SKU-backed now (Sean 2026-11), so it needs no mapping; `ledLibraryMapping` is kept as a harmless extra that fixtures may still seed. A fixture that wants to get a COSTED demo quotation
// approved approves with the Manager's recorded exception (`managerExceptionOpts`). A typed-price product with no Cin7 mapping (that cannot be covered) is the optional controller.
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

/**
 * For downstream fixtures (Project / Sale scope / invoicing) that are ABOUT unresolved physical scope: a baseline whose scope still lists M75, penning and LED as UNMAPPED, as the
 * golden quotation was sealed before the Manager exception existed. `buildAcceptedBaseline` now refuses to freeze such a quotation without the exception and a mapped LED package, so
 * this seals it with the golden library and then restores the unresolved scope (and a fresh seal). Only the scope differs from a real seal; nothing downstream reads `exceptions`.
 */
import { buildAcceptedBaseline, deepFreeze, hashOf, type BaselineCommercialLine, type BaselineInput } from "@/newquip/quote/baseline";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { applyMappingLibrary, type LibraryMapping } from "@/lib/projects/product-scope";
import { GOLDEN_LIBRARY } from "./golden-catalogue";
/**
 * The LED package is SKU-backed now (HNQ7046 / HNQ7093 / HNQ7088, Sean 2026-11), so it is no longer an unresolved item. For fixtures ABOUT unresolved physical scope that need a THIRD
 * unmapped, Estimator-priced product next to M75 and penning, `unmappedController: true` adds the optional controller (a typed price, no Cin7 mapping) to the PHYSICAL SCOPE ONLY: the commercial
 * lines, prices and the contract amount are untouched.
 */
export const UNMAPPED_CONTROLLER_LINE: BaselineCommercialLine = { itemKey: "controller", label: "Thomas-CL1 controller (Estimator price, no Cin7 mapping)", sku: null, quantity: 2, unitPriceExVat: 3000, revenueCents: 600_000, pricedBy: "estimator_resolution", note: "" };
export function sealWithUnresolvedScope(input: Omit<BaselineInput, "baselineException" | "mappingLibrary">, library?: ReadonlyMap<string, LibraryMapping>, opts: { unmappedController?: boolean } = {}) {
  const { baseline } = buildAcceptedBaseline({ ...input, mappingLibrary: GOLDEN_LIBRARY as never });
  const b = structuredClone(baseline) as typeof baseline;
  const scope = buildPhysicalScope(opts.unmappedController ? [...b.commercial.lines, UNMAPPED_CONTROLLER_LINE] : b.commercial.lines);
  b.physicalScope = library && library.size ? applyMappingLibrary(scope, library, input.approvals.managerApprovedAt) : scope;
  delete b.exceptions;
  return { baseline: deepFreeze(b), hash: hashOf(b) };
}
