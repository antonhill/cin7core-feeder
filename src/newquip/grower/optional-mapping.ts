// Optional additional elements (controller, silo weighing, ...) are mapped by the estimator to a Cin7 product chosen from the synced catalogue.
// These pure helpers say which SKUs a draft claims to have mapped, and check them against what the catalogue actually holds.

import { OPTIONAL_ITEM_KEYS, type OptionalItemKey } from "./types";

export function optionalMappedSkus(confirmedMappings: Partial<Record<string, string>> | undefined): Array<{ itemKey: OptionalItemKey; sku: string }> {
  const out: Array<{ itemKey: OptionalItemKey; sku: string }> = [];
  for (const k of OPTIONAL_ITEM_KEYS) {
    const sku = confirmedMappings?.[k];
    if (typeof sku === "string" && sku.trim()) out.push({ itemKey: k, sku: sku.trim() });
  }
  return out;
}

/** First problem with the optional mappings against the catalogue rows read for them, or null. A SKU that is not in the catalogue, or is inactive, is refused. */
export function optionalMappingError(mapped: ReadonlyArray<{ itemKey: string; sku: string }>, catalogue: ReadonlyArray<{ sku: string; active: boolean | null }>): string | null {
  const bySku = new Map(catalogue.map((c) => [c.sku, c]));
  for (const m of mapped) {
    const row = bySku.get(m.sku);
    if (!row) return `${m.sku} is not in the synced Cin7 catalogue, so it cannot be used as the product for ${m.itemKey.replace(/_/g, " ")}.`;
    if (row.active === false) return `${m.sku} is inactive in Cin7, so it cannot be used as the product for ${m.itemKey.replace(/_/g, " ")}.`;
  }
  return null;
}

/** Trims every optional mapping and drops anything that is not a non-empty string, so what is verified is exactly what is stored. */
export function normaliseOptionalMappings<T extends { estimator: { confirmedMappings: Partial<Record<string, string>> } }>(draft: T): T {
  const next = { ...draft.estimator.confirmedMappings } as Record<string, unknown>;
  for (const k of OPTIONAL_ITEM_KEYS) {
    const v = next[k];
    if (v === undefined) continue;
    if (typeof v === "string" && v.trim()) next[k] = v.trim(); else delete next[k];
  }
  return { ...draft, estimator: { ...draft.estimator, confirmedMappings: next as Partial<Record<string, string>> } };
}

/** True when the optional-element mappings differ between two drafts (a change of WHAT the quotation is built from). */
export function optionalMappingsChanged(prior: Partial<Record<string, string>> | undefined, next: Partial<Record<string, string>> | undefined): boolean {
  return OPTIONAL_ITEM_KEYS.some((k) => (prior?.[k] ?? null) !== (next?.[k] ?? null));
}
