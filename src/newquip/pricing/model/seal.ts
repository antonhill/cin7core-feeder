import { hashOf } from "../../quote/baseline";
import type { PricingResult } from "./calculate";

// IMMUTABLE ORIGINAL VERSUS REVISED (NQ-008B Phase 1). Sealing a result deep-freezes a COPY of it and records a content hash, so the "original" quotation can be held next
// to any number of revisions and can never be altered by them: a later calculation is a new result, and the only way to relate it to the original is to compare.
// (Persisting a sealed result append-only is Phase 2; the hash is what the stored row will carry, exactly as for the NQ-008A indicative snapshot.)

export interface SealedPricing { readonly result: Readonly<PricingResult>; readonly hash: string }

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v); }
  return o;
}

export function sealPricing(result: PricingResult): SealedPricing {
  const copy = structuredClone(result);
  return { result: deepFreeze(copy), hash: hashOf(copy) };
}

/** True when the sealed result still matches its hash (it cannot have been altered through a frozen object, but a stored copy might be). */
export const verifySealed = (s: SealedPricing): boolean => hashOf(s.result) === s.hash;
