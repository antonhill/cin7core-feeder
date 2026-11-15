import { stableStringify } from "../../quote/baseline";
import type { PricingSubmission } from "./apply";
import type { EstimatorPricing } from "./types";

// FIELD-LEVEL THREE-WAY MERGE of an Estimator pricing save (reliability fix: no silent cost overwrite). Pure; no I/O; exact values only (E7 costs and micro rates are compared as the integers they are).
//
//   base   = the stored pricing the user's edits were MADE AGAINST (what the panel last showed them as stored, per unit),
//   stored = the pricing stored NOW,
//   draft  = what the user submits.
//
// For every unit (a SKU cost FIELD, an exchange-rate entry, a forward-cover entry, a price override, the project markup, the target price, the rule version):
//   draft == base     the user did not touch it  -> take the CURRENT stored value (never revert somebody else's change),
//   draft == stored   already the same            -> nothing to do,
//   stored == base    only the user changed it     -> take the draft value,
//   otherwise         both changed it, differently -> CONFLICT: refused, nothing is saved, the conflict is named.
// The merge is authoritative on the server; the panel runs the same function to REBASE a held draft when the stored pricing changes underneath it.

/** One unit that both the user and someone else changed differently. `key` identifies the unit for the panel; `label` is plain language. */
export interface PricingConflict { key: string; label: string; /** Who changed the stored value, and when (the stored entry's own stamp), when known. */ by?: string; at?: string }
export interface MergeResult { merged: PricingSubmission; conflicts: PricingConflict[] }

const norm = (x: unknown): string => stableStringify(JSON.parse(JSON.stringify(x ?? null), (k, v) => (k === "by" || k === "at" ? undefined : k === "reason" && typeof v === "string" ? v.trim() : v)));
export const samePricingValue = (a: unknown, b: unknown): boolean => norm(a) === norm(b);

/** The empty submission a draft is based on while supplier pricing was OFF. */
export function emptySubmission(ruleVersionId: string): PricingSubmission {
  return { ruleVersionId, skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null };
}

const SKU_FIELDS = ["supplierId", "supplierName", "currency", "nativeUnitCostE7", "source", "freight"] as const;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Every unit of a submission, as `key -> value`. Used for the unsaved-change diff and for conflict labelling. SKU entries are units of their own FIELDS. */
export function pricingUnits(s: PricingSubmission): Map<string, unknown> {
  const m = new Map<string, unknown>();
  m.set("rule", s.ruleVersionId);
  for (const [k, v] of Object.entries(s.skus)) { if (!v) continue; for (const f of SKU_FIELDS) m.set(`sku:${k}:${f}`, (v as Record<string, unknown>)[f] ?? null); m.set(`sku:${k}`, "present"); }
  for (const [k, v] of Object.entries(s.fxQuotes)) m.set(`fx:${k}`, v);
  for (const [k, v] of Object.entries(s.forwardCover)) m.set(`fwd:${k}`, v);
  for (const [k, v] of Object.entries(s.skuPriceOverrides)) m.set(`override:${k}`, v);
  m.set("markup", s.projectMarkup);
  m.set("target", s.targetAdjustment);
  return m;
}

/** The units whose value differs between two submissions. */
export function changedUnits(a: PricingSubmission, b: PricingSubmission): string[] {
  const x = pricingUnits(a), y = pricingUnits(b);
  return [...new Set([...x.keys(), ...y.keys()])].filter((k) => !samePricingValue(x.get(k) ?? null, y.get(k) ?? null)).sort();
}
/** Distinct things the user would notice as ONE change (a SKU row, an exchange rate ...): the unit keys collapsed to their owner. */
export function changedOwners(a: PricingSubmission, b: PricingSubmission): string[] {
  return [...new Set(changedUnits(a, b).map((k) => (k.startsWith("sku:") ? k.split(":").slice(0, 2).join(":") : k)))].sort();
}

function resolve<T>(b: T | undefined, s: T | undefined, d: T | undefined): { value: T | undefined; conflict: boolean } {
  if (samePricingValue(b, d)) return { value: s, conflict: false };
  if (samePricingValue(s, d)) return { value: d, conflict: false };
  if (samePricingValue(b, s)) return { value: d, conflict: false };
  return { value: d, conflict: true };
}

const unitLabel = (key: string): string => {
  const [kind, id, field] = key.split(":");
  if (kind === "sku") return field ? `SKU ${id} ${({ supplierId: "supplier", supplierName: "supplier", currency: "currency", nativeUnitCostE7: "cost", source: "cost source", freight: "freight" } as Record<string, string>)[field] ?? field}` : `SKU ${id}`;
  if (kind === "fx") return `${id} exchange rate`;
  if (kind === "fwd") return `${id} forward-cover rate`;
  if (kind === "override") return `SKU ${id} price override`;
  if (kind === "markup") return "the project markup";
  if (kind === "target") return "the target project price";
  if (kind === "rule") return "the pricing rule version";
  return key;
};
const stampOf = (stored: EstimatorPricing | null | undefined, key: string): { by?: string; at?: string } => {
  if (!stored) return {};
  const [kind, id] = key.split(":");
  const e = kind === "sku" ? stored.skus[id] : kind === "fx" ? stored.fxQuotes[id] : kind === "fwd" ? stored.forwardCover[id] : kind === "override" ? stored.skuPriceOverrides[id] : kind === "markup" ? stored.projectMarkup : kind === "target" ? stored.targetAdjustment : undefined;
  const x = e as { by?: string; at?: string; asOf?: string } | null | undefined;
  return x ? { by: x.by, at: x.at ?? x.asOf } : {};
};

/**
 * Three-way merge of `draft` onto `stored`, given the `base` the draft was edited from. Conflicts are listed per unit; `merged` is the draft with every untouched unit taken from `stored`
 * (on a conflict `merged` keeps the DRAFT value for that unit: it is only ever used to rebase the panel, never saved while conflicts exist).
 */
export function mergePricing(base: PricingSubmission, stored: PricingSubmission, draft: PricingSubmission, storedPricing?: EstimatorPricing | null): MergeResult {
  const conflicts: PricingConflict[] = [];
  const flag = (key: string) => { if (!conflicts.some((c) => c.key === key)) conflicts.push({ key, label: unitLabel(key), ...stampOf(storedPricing, key) }); };
  const merged: PricingSubmission = emptySubmission(draft.ruleVersionId);

  { const r = resolve(base.ruleVersionId, stored.ruleVersionId, draft.ruleVersionId); merged.ruleVersionId = r.value ?? draft.ruleVersionId; if (r.conflict) flag("rule"); }

  const skuKeys = new Set([...Object.keys(base.skus), ...Object.keys(stored.skus), ...Object.keys(draft.skus)]);
  for (const k of [...skuKeys].sort()) {
    const b = own(base.skus, k) ? base.skus[k] : undefined, s = own(stored.skus, k) ? stored.skus[k] : undefined, d = own(draft.skus, k) ? draft.skus[k] : undefined;
    if (!b || !s || !d) { // the entry appears or disappears somewhere: it is decided as ONE unit
      const r = resolve(b, s, d); if (r.value) merged.skus[k] = structuredClone(r.value);
      if (r.conflict) flag(`sku:${k}`);
      continue;
    }
    const out: Record<string, unknown> = {};
    for (const f of SKU_FIELDS) {
      const r = resolve((b as Record<string, unknown>)[f], (s as Record<string, unknown>)[f], (d as Record<string, unknown>)[f]);
      if (r.value !== undefined) out[f] = structuredClone(r.value);
      if (r.conflict) flag(`sku:${k}:${f}`);
    }
    merged.skus[k] = out as PricingSubmission["skus"][string];
  }
  const maps = [["fxQuotes", "fx"], ["forwardCover", "fwd"], ["skuPriceOverrides", "override"]] as const;
  for (const [field, tag] of maps) {
    const B = base[field] as Record<string, unknown>, S = stored[field] as Record<string, unknown>, D = draft[field] as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(B), ...Object.keys(S), ...Object.keys(D)])].sort()) {
      const r = resolve(own(B, k) ? B[k] : undefined, own(S, k) ? S[k] : undefined, own(D, k) ? D[k] : undefined);
      if (r.value !== undefined) (merged[field] as Record<string, unknown>)[k] = structuredClone(r.value);
      if (r.conflict) flag(`${tag}:${k}`);
    }
  }
  for (const [field, tag] of [["projectMarkup", "markup"], ["targetAdjustment", "target"]] as const) {
    const r = resolve(base[field], stored[field], draft[field]);
    (merged as unknown as Record<string, unknown>)[field] = r.value === undefined ? null : structuredClone(r.value);
    if (r.conflict) flag(tag);
  }
  return { merged, conflicts: conflicts.sort((a, b) => a.key.localeCompare(b.key)) };
}

/** The plain-language refusal for a stale save. Names each conflicting unit and who/when changed it. */
export function conflictMessage(conflicts: readonly PricingConflict[]): string {
  const bits = conflicts.slice(0, 6).map((c) => `${c.label} was changed by ${c.by ?? "another user"}${c.at ? ` at ${c.at}` : ""}`);
  return `Nothing was saved: ${bits.join("; ")}${conflicts.length > 6 ? `; and ${conflicts.length - 6} more` : ""}. Reload to review; your typed values are kept until you choose.`;
}

/**
 * Copies ONE unit (see `pricingUnits`) from `from` into `to`, deleting it from `to` when `from` has none. The panel uses it to rebase (a unit takes the stored value as its base), to "keep my value"
 * (the base of that unit becomes the stored value) and to "use the stored value" (draft and base both).
 */
export function copyUnit(to: PricingSubmission, from: PricingSubmission, key: string): void {
  const [kind, id, field] = key.split(":");
  const maps = { fx: "fxQuotes", fwd: "forwardCover", override: "skuPriceOverrides" } as const;
  if (kind === "rule") { to.ruleVersionId = from.ruleVersionId; return; }
  if (kind === "markup") { to.projectMarkup = from.projectMarkup ? structuredClone(from.projectMarkup) : null; return; }
  if (kind === "target") { to.targetAdjustment = from.targetAdjustment ? structuredClone(from.targetAdjustment) : null; return; }
  if (kind === "sku") {
    const src = own(from.skus, id) ? from.skus[id] : undefined;
    if (!field || !src || !own(to.skus, id) || !to.skus[id]) { if (src) to.skus[id] = structuredClone(src); else delete to.skus[id]; return; }
    const v = (src as Record<string, unknown>)[field];
    if (v === undefined) delete (to.skus[id] as Record<string, unknown>)[field]; else (to.skus[id] as Record<string, unknown>)[field] = structuredClone(v);
    return;
  }
  if (kind in maps) {
    const f = maps[kind as keyof typeof maps];
    const S = from[f] as Record<string, unknown>, T = to[f] as Record<string, unknown>;
    if (own(S, id) && S[id] !== undefined) T[id] = structuredClone(S[id]); else delete T[id];
  }
}
