// Exceptional MANUAL QUOTATION PRICES (an estimator resolution for a line the approved price source cannot price). They are quote inputs only: never written
// back to Cin7 or to the master snapshot. Who set each one and when is stamped by the SERVER (like cost overrides), only when the price or its reason actually
// changes, and only an Estimator or Manager may create or change one. Everything is pure so the rules can be proved without a database.

import type { EstimatorResolution } from "../grower/quote-bridge";
import type { QuoteRole } from "./roles";

export type ResolutionMap = Partial<Record<string, EstimatorResolution>>;
const same = (a: EstimatorResolution | undefined, b: EstimatorResolution | undefined): boolean =>
  !!a && !!b && a.unitPriceExVat === b.unitPriceExVat && (a.reason ?? "").trim() === (b.reason ?? "").trim();

/** Returns the draft's resolutions with server-owned provenance. Throws a plain message when the caller may not change them. */
export function stampPriceResolutions(
  submitted: ResolutionMap | undefined, prior: ResolutionMap | undefined, roles: ReadonlySet<QuoteRole>, email: string, nowIso: string,
): ResolutionMap {
  const out: ResolutionMap = {};
  const mayEdit = roles.has("estimator") || roles.has("manager");
  for (const [k, r] of Object.entries(submitted ?? {})) {
    if (!r) continue;
    const before = prior?.[k];
    if (same(before, r)) { out[k] = before; continue; } // unchanged: keep the earlier stamp, ignore anything the client sent
    if (!mayEdit) throw new Error("Only an Estimator or Manager can enter or change a manual quotation price.");
    out[k] = { unitPriceExVat: r.unitPriceExVat, reason: (r.reason ?? "").trim(), by: email, at: nowIso };
  }
  // Removing a resolution is also a change.
  if (!mayEdit && Object.keys(prior ?? {}).some((k) => prior![k] && !out[k])) throw new Error("Only an Estimator or Manager can remove a manual quotation price.");
  return out;
}
