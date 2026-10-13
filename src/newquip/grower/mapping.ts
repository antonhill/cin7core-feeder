import type { GrowerItemKey } from "./types";

// Engineering output → Cin7 product mapping, kept OUT of the formulas (rules.ts never names a SKU).
//
// ONE SOURCE OF TRUTH for mapping status. Everything — the server discovery action, the UI, the tests and
// the rule register — goes through the two functions below:
//
//   isPlausibleCandidate(itemKey, productName)   what counts as a candidate at all
//   resolveMapping(itemKey, candidates, confirmed, catalogue)   what status that yields
//
//   MAPPED    = exactly one explicitly confirmed product that exists in the catalogue
//   AMBIGUOUS = one or more plausible candidates exist, none confirmed (never auto-confirmed, even for one)
//   UNMAPPED  = no plausible candidate exists
//
// A historic description existing (the Topigs line text) is NOT a candidate. A loose keyword hit (any part
// with "silo" or "M75" in its name) is NOT a candidate: a candidate must satisfy every `include` pattern and
// no `exclude` pattern for the item. Confirmed SKUs are client-session state in this interim build.

export type MappingStatus = "MAPPED" | "AMBIGUOUS" | "UNMAPPED";

export interface MappingMatcher {
  itemKey: GrowerItemKey;
  /** Cheap DB prefilter terms (ILIKE). Over-inclusive on purpose — plausibility is decided in code, not SQL. */
  seeds: string[];
  /** Every pattern must match the product name. */
  include: RegExp[];
  /** Any match disqualifies (accessories, parts, other sizes). */
  exclude: RegExp[];
  /** Why a match is plausible — shown beside the choice. */
  reason: string;
}

export const MAPPING_MATCHERS: MappingMatcher[] = [
  { itemKey: "bulk_tank", seeds: ["silo", "tank"], include: [/\b13[.,]?39\b|\b1339\b/i, /silo|tank/i], exclude: [], reason: "names a 13.39t silo/tank" },
  { itemKey: "flex_auger", seeds: ["M75"], include: [/M75/i, /flex|auger/i, /system|complete|\bline\b/i], exclude: [/drop kit|control unit|bushing|bearing|clamp|fastening/i], reason: "an M75 Flex auger SYSTEM (not a part)" },
  { itemKey: "feeder", seeds: ["CCM"], include: [/CCM/i, /feeder/i, /grower/i], exclude: [/weaner|do not use|handle|bracket|brace|gusset|rod\b|dosing|unit\b/i], reason: "CCM feeder for growers" },
  { itemKey: "feed_saver_mat", seeds: ["feed saver"], include: [/feed saver mat/i, /1000\s*x\s*1000|\b1\s*m\s*x\s*1\s*m\b/i], exclude: [], reason: "feed saver mat, 1000 × 1000 mm" },
  { itemKey: "cup_drinker", seeds: ["cup drinker"], include: [/cup drinker/i, /grower/i], exclude: [/nipple|bracket|backing|socket|manifold|\bsow\b/i], reason: "cup drinker for growers" },
  { itemKey: "concrete_slat", seeds: ["concrete slat"], include: [/concrete slat/i, /\(12\s*x\s*0?45|\(1200\s*x\s*45\d/i], exclude: [/mould|fastener|frame/i], reason: "concrete slat, 1.2 × 0.45 m" },
  { itemKey: "penning_package", seeds: ["venti"], include: [/\bPP\b/i, /50\s*mm/i, /venti/i, /green/i], exclude: [], reason: "PP 50mm green vented penning" },
  { itemKey: "led_light", seeds: ["fortis"], include: [/fortis/i], exclude: [], reason: "FORTIS LED lighting" },
  { itemKey: "pvc_door", seeds: ["door"], include: [/door/i, /pvc|polyp\w*/i, /sst|alu/i], exclude: [/post|handle|latch|hinge|\bcap\b|trap|channel/i], reason: "PVC/polypropylene door with SST or aluminium frame" },
];

const MATCHER_BY_ITEM = new Map(MAPPING_MATCHERS.map((m) => [m.itemKey, m]));

export function matcherFor(itemKey: GrowerItemKey): MappingMatcher | undefined {
  return MATCHER_BY_ITEM.get(itemKey);
}

/** THE definition of "plausible candidate". Pure. */
export function isPlausibleCandidate(itemKey: GrowerItemKey, productName: string): boolean {
  const m = MATCHER_BY_ITEM.get(itemKey);
  if (!m) return false;
  const name = productName ?? "";
  return m.include.every((re) => re.test(name)) && !m.exclude.some((re) => re.test(name));
}

export interface MappingCandidate {
  sku: string;
  name: string;
  /** Display-only detail for the chooser; never used to decide status. */
  averageCost?: number | null;
  available?: number | null;
  reason?: string;
  /** True for the source-backed recommendation (documentary evidence) — NOT a human confirmation. */
  recommended?: boolean;
}

/**
 * Precedence (never automatic confirmation):
 *   1. exact source-backed SKU, listed first and flagged `recommended`
 *   2. (human confirmation is applied later, by resolveMapping)
 *   3. plausible catalogue candidates, de-duplicated against the recommendation
 *   4. nothing → UNMAPPED
 */
export function mergeCandidates(recommended: MappingCandidate | null, plausible: MappingCandidate[]): MappingCandidate[] {
  if (!recommended) return plausible;
  return [{ ...recommended, recommended: true }, ...plausible.filter((c) => c.sku !== recommended.sku)];
}

export interface MappingResolution {
  itemKey: GrowerItemKey;
  status: MappingStatus;
  sku: string | null;
  candidates: MappingCandidate[];
  /** A source-backed recommendation exists but nobody has confirmed it yet. */
  awaitingConfirmationOfRecommendation: boolean;
  note: string;
}

/**
 * @param candidates plausible candidates for this item (from the catalogue, already filtered by isPlausibleCandidate)
 * @param confirmedSku the SKU a person explicitly chose (or null)
 * @param catalogue extra SKUs known to exist in the synced catalogue (candidates are always known to exist)
 */
export function resolveMapping(
  itemKey: GrowerItemKey,
  candidates: MappingCandidate[],
  confirmedSku: string | null,
  catalogue: ReadonlySet<string> = new Set(),
): MappingResolution {
  const sku = confirmedSku?.trim() || null;
  if (sku) {
    const exists = candidates.some((c) => c.sku === sku) || catalogue.has(sku);
    if (!exists) return { itemKey, status: "UNMAPPED", sku: null, candidates, awaitingConfirmationOfRecommendation: false, note: `Confirmed SKU ${sku} not found in the synced catalogue.` };
    return { itemKey, status: "MAPPED", sku, candidates, awaitingConfirmationOfRecommendation: false, note: "Confirmed." };
  }
  if (candidates.length >= 1) {
    const rec = candidates.find((c) => c.recommended);
    return {
      itemKey,
      status: "AMBIGUOUS",
      sku: null,
      candidates,
      awaitingConfirmationOfRecommendation: Boolean(rec),
      note: rec
        ? `Recommended from NewQuip source: ${rec.sku} — awaiting NewQuip confirmation (not yet confirmed).`
        : `REQUIRES NEWQUIP SKU CONFIRMATION — ${candidates.length === 1 ? "one candidate, not yet confirmed" : `${candidates.length} candidates`}.`,
    };
  }
  return { itemKey, status: "UNMAPPED", sku: null, candidates: [], awaitingConfirmationOfRecommendation: false, note: "No plausible product in the synced catalogue." };
}
