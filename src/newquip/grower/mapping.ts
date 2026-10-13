import type { GrowerItemKey } from "./types";

// Engineering output → Cin7 product mapping, kept OUT of the formulas (rules.ts never names a SKU).
//
// STATE: as of 2026-10-13 the NewQuip POC org has 0 synced products, so no SKU could be verified.
// The seed therefore holds search hints only. A mapping becomes MAPPED only when exactly one SKU is
// confirmed for the item AND that SKU exists in the synced catalogue; several plausible SKUs with none
// confirmed is AMBIGUOUS (REQUIRES NEWQUIP SKU CONFIRMATION). Confirmed SKUs are client-session state in
// this interim build (no persistence — see the proposed migration in the POC docs).

export type MappingStatus = "MAPPED" | "AMBIGUOUS" | "UNMAPPED";

export interface MappingHint {
  itemKey: GrowerItemKey;
  /** Keyword sets searched against Cin7 SKU/name to propose candidates. */
  keywords: string[];
}

export const MAPPING_HINTS: MappingHint[] = [
  { itemKey: "bulk_tank", keywords: ["13.39", "bulk feed tank", "silo"] },
  { itemKey: "flex_auger", keywords: ["M75", "flex auger"] },
  { itemKey: "feeder", keywords: ["CCM"] },
  { itemKey: "feed_saver_mat", keywords: ["feed saver"] },
  { itemKey: "cup_drinker", keywords: ["cup drinker"] },
  { itemKey: "concrete_slat", keywords: ["slat"] },
  { itemKey: "penning_package", keywords: ["penning"] },
  { itemKey: "led_light", keywords: ["FORTIS"] },
  { itemKey: "pvc_door", keywords: ["door"] },
];

export interface MappingCandidate {
  sku: string;
  name: string;
}

export interface MappingResolution {
  itemKey: GrowerItemKey;
  status: MappingStatus;
  sku: string | null;
  candidates: MappingCandidate[];
  note: string;
}

/**
 * @param candidates SKUs proposed by catalogue discovery for this item
 * @param confirmedSku the SKU a person confirmed for this item (or null)
 * @param catalogue SKUs known to exist (and be active) in the synced catalogue
 */
export function resolveMapping(
  itemKey: GrowerItemKey,
  candidates: MappingCandidate[],
  confirmedSku: string | null,
  catalogue: ReadonlySet<string>,
): MappingResolution {
  const sku = confirmedSku?.trim() || null;
  if (sku) {
    if (!catalogue.has(sku)) {
      return { itemKey, status: "UNMAPPED", sku: null, candidates, note: `Confirmed SKU ${sku} not found in the synced catalogue.` };
    }
    return { itemKey, status: "MAPPED", sku, candidates, note: "Confirmed." };
  }
  if (candidates.length > 1) {
    return { itemKey, status: "AMBIGUOUS", sku: null, candidates, note: "REQUIRES NEWQUIP SKU CONFIRMATION — several candidate products." };
  }
  if (candidates.length === 1) {
    return { itemKey, status: "AMBIGUOUS", sku: null, candidates, note: "REQUIRES NEWQUIP SKU CONFIRMATION — one candidate, not yet confirmed." };
  }
  return { itemKey, status: "UNMAPPED", sku: null, candidates: [], note: "No candidate product found in the synced catalogue." };
}
