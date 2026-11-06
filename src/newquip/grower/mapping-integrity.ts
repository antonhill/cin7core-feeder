// Confirmed product mappings (item -> Cin7 SKU) decide WHAT a quotation is built from, so they are an Estimator/Manager decision and must name a real, active
// catalogue product. These pure helpers say which SKUs a draft claims to have mapped, whether they changed, and check them against the catalogue rows read for them.
// They cover EVERY item key (the optional additional elements, pvc_door and the source-backed items alike). The server applies them when a draft is stored and again
// at estimator sign-off.

import { expectedSkuFor } from "./quote-bridge";
import { GROWER_ITEM_KEYS, isOptionalItemKey, type FeederVariant, type GrowerItemKey } from "./types";

type Mappings = Partial<Record<string, string>> | undefined;

const isItemKey = (k: string): k is GrowerItemKey => (GROWER_ITEM_KEYS as readonly string[]).includes(k);
const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Every mapping a draft claims, trimmed. Blank and non-string values are not mappings. */
export function mappedSkus(confirmedMappings: Mappings): Array<{ itemKey: string; sku: string }> {
  const out: Array<{ itemKey: string; sku: string }> = [];
  for (const [itemKey, v] of Object.entries(confirmedMappings ?? {})) {
    const sku = clean(v);
    if (sku) out.push({ itemKey, sku });
  }
  return out;
}

/**
 * First problem with the mappings against the catalogue rows read for them, or null:
 * - a key that is not a known item, or a SKU not in the catalogue or inactive, is refused;
 * - an item with a source-backed SKU (everything except pvc_door and the optional elements, which the estimator chooses) must map to exactly that SKU.
 */
export function mappingError(mapped: ReadonlyArray<{ itemKey: string; sku: string }>, catalogue: ReadonlyArray<{ sku: string; active: boolean | null }>, feederVariant?: FeederVariant): string | null {
  const bySku = new Map(catalogue.map((c) => [c.sku, c]));
  for (const m of mapped) {
    const what = m.itemKey.replace(/_/g, " ");
    if (!isItemKey(m.itemKey)) return `${m.itemKey} is not a product slot on this quotation.`;
    if (m.itemKey !== "pvc_door" && !isOptionalItemKey(m.itemKey)) {
      const expected = expectedSkuFor(m.itemKey, feederVariant);
      if (expected && m.sku !== expected) return `${m.sku} is not the source-backed product (${expected}) for ${what}.`;
    }
    const row = bySku.get(m.sku);
    if (!row) return `${m.sku} is not in the synced Cin7 catalogue, so it cannot be used as the product for ${what}.`;
    if (row.active === false) return `${m.sku} is inactive in Cin7, so it cannot be used as the product for ${what}.`;
  }
  return null;
}

/** Trims every mapping and drops blanks, non-strings and unknown item keys, so what is verified is exactly what is stored. */
export function normaliseMappings<T extends { estimator: { confirmedMappings: Partial<Record<string, string>> } }>(draft: T): T {
  const next: Record<string, string> = {};
  for (const m of mappedSkus(draft.estimator.confirmedMappings)) if (isItemKey(m.itemKey)) next[m.itemKey] = m.sku;
  return { ...draft, estimator: { ...draft.estimator, confirmedMappings: next as Partial<Record<string, string>> } };
}

/** The mappings that are new or different in `next` (the only ones a save has to re-verify against the catalogue). */
export function changedMappings(prior: Mappings, next: Mappings): Array<{ itemKey: string; sku: string }> {
  const before = new Map(mappedSkus(prior).map((m) => [m.itemKey, m.sku]));
  return mappedSkus(next).filter((m) => before.get(m.itemKey) !== m.sku);
}

/** True when the mappings differ between two drafts in any way: added, changed or removed (a change of WHAT the quotation is built from). */
export function mappingsChanged(prior: Mappings, next: Mappings): boolean {
  const a = new Map(mappedSkus(prior).map((m) => [m.itemKey, m.sku]));
  const b = new Map(mappedSkus(next).map((m) => [m.itemKey, m.sku]));
  if (a.size !== b.size) return true;
  for (const [k, v] of b) if (a.get(k) !== v) return true;
  return false;
}
