import type { BudgetQuote } from "../../grower/quote-bridge";
import { hashOf } from "../../quote/baseline";
import { canEnterPricingInputs, type Viewer } from "../model";
import { diffPricing, type PricingChange } from "./apply";
import type { EstimatorPricing, ManualPriceEvidence } from "./types";

// PRICING EVIDENCE FOR SKU-LESS MANUAL ITEMS (NQ-008B P2-E). Pure. Some items are priced by the Estimator with NO physical SKU behind them: the M75 system, LED lighting, penning, any
// manual item. Their price cannot be checked against a supplier cost the way a SKU can, so a recorded evidence note (what the price is based on) is required before final approval.
// NO SKU IS INVENTED and no price or formula is touched: this only records a note against the item, bound to the price it explains (a later price change makes it outdated).
//
// OPT-IN with supplier pricing: when `estimator.pricing` is not enabled nothing here applies and the legacy POC behaviour is unchanged. Items whose SKU supplier cost is already governed
// by cost verification (a manual price on a SKU line) are excluded: cost verification covers them.

export interface ManualItem { itemKey: string; label: string; /** The item's current unit price in cents (the line's revenue when it has no unit price): what the evidence is bound to. */ unitPriceCents: number; pricedBy: "estimator_input" | "estimator_resolution" | "penning_rate" }

const MANUAL_BY = new Set(["estimator_input", "estimator_resolution", "penning_rate"]);

/**
 * Priced budget lines the Estimator prices by hand that cost verification does NOT govern. Sorted by key. Never invents a SKU.
 *  - M75 / penning (`estimator_input`, `penning_rate`): the Estimator prices the system as a whole. Cost verification already skips these lines entirely (see skuNeedsOf), whatever
 *    component SKUs they list for reference (the M75 line lists some), so they always need evidence here.
 *  - a manual price resolution (`estimator_resolution`, e.g. LED lighting): needs evidence only when the line has no SKU of its own and no non-reference component SKU; a line whose
 *    SKU carries a supplier cost is governed by cost verification (manualPricedSkus) instead.
 */
export function skuLessManualItems(budget: BudgetQuote | null): ManualItem[] {
  const out: ManualItem[] = [];
  for (const l of budget?.lines ?? []) {
    if (l.status !== "priced" || !l.pricedBy || !MANUAL_BY.has(l.pricedBy)) continue;
    if (l.pricedBy === "estimator_resolution") {
      if (l.sku) continue;
      if (l.components?.some((c) => !!c.sku && c.status !== "reference_only")) continue;
    } else if (l.sku) continue; // a SKU line priced by the Estimator's own input: its SKU is its identity, not a SKU-less item
    const price = l.unitPrice ?? l.revenueExTax;
    if (price === null || price === undefined) continue;
    out.push({ itemKey: String(l.itemKey), label: l.label, unitPriceCents: Math.round(price * 100), pricedBy: l.pricedBy as ManualItem["pricedBy"] });
  }
  return out.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
}

/** What a piece of evidence covers: the item, its current unit price and what priced it. NOT who wrote it, when, or the note itself. */
export const manualPriceHash = (i: Pick<ManualItem, "itemKey" | "unitPriceCents" | "pricedBy">): string => hashOf({ itemKey: i.itemKey, unitPriceCents: i.unitPriceCents, pricedBy: i.pricedBy });

export type EvidenceState = "missing" | "recorded" | "outdated";

export function evidenceStateOf(item: ManualItem, p: Pick<EstimatorPricing, "manualEvidence"> | undefined): EvidenceState {
  const e = p?.manualEvidence && Object.prototype.hasOwnProperty.call(p.manualEvidence, item.itemKey) ? p.manualEvidence[item.itemKey] : undefined;
  if (!e) return "missing";
  return e.priceHash === manualPriceHash(item) ? "recorded" : "outdated";
}

export const EVIDENCE_STATE_TEXT: Record<EvidenceState, string> = {
  missing: "no pricing evidence has been recorded",
  recorded: "evidence recorded",
  outdated: "the price changed after its evidence was recorded, so the evidence needs recording again",
};

export const MIN_EVIDENCE_NOTE = 10;
export const MAX_EVIDENCE_NOTE = 500;
const MAX_REFERENCE = 100;
const RESERVED = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]);

/** What the Estimator submits for one item: the key and the note. The hash and attribution are decided by the server. */
export interface EvidenceItem { itemKey: string; note: string; reference?: string }
export type EvidenceResult = { ok: true; next: EstimatorPricing; changes: PricingChange[] } | { ok: false; errors: string[] };

/**
 * Records evidence notes for SKU-less manual items. `budget` MUST be the server's freshly evaluated (cost-visible) budget: the hash is computed from it, never from anything the client
 * sent. Refuses the WHOLE request if the viewer may not enter pricing inputs, an item is not a current SKU-less manual item, a note is outside 10 to 500 characters, or a key is reserved.
 */
export function applyManualEvidence(prior: EstimatorPricing | undefined, budget: BudgetQuote | null, items: readonly EvidenceItem[], viewer: Viewer, email: string, nowIso: string): EvidenceResult {
  if (!prior) return { ok: false, errors: ["Supplier pricing is not switched on for this quotation."] };
  if (!canEnterPricingInputs(viewer)) return { ok: false, errors: ["Only an Estimator or Manager who can see costs can record pricing evidence."] };
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return { ok: false, errors: ["Choose at least one item to record evidence for."] };
  const current = new Map(skuLessManualItems(budget).map((i) => [i.itemKey, i]));
  const errors: string[] = [];
  const next = structuredClone(prior);
  const store: Record<string, ManualPriceEvidence | undefined> = { ...(next.manualEvidence ?? {}) };
  const seen = new Set<string>();
  for (const it of items) {
    const key = it?.itemKey;
    if (typeof key !== "string" || RESERVED.has(key) || !current.has(key)) { errors.push(`${String(key).slice(0, 40)}: this is not an item that needs pricing evidence.`); continue; }
    if (seen.has(key)) { errors.push(`${current.get(key)!.label}: listed twice.`); continue; }
    seen.add(key);
    const item = current.get(key)!;
    const note = typeof it.note === "string" ? it.note.trim() : "";
    if (note.length < MIN_EVIDENCE_NOTE || note.length > MAX_EVIDENCE_NOTE) { errors.push(`${item.label}: say what the price is based on (${MIN_EVIDENCE_NOTE} to ${MAX_EVIDENCE_NOTE} characters).`); continue; }
    const refRaw = it.reference;
    if (refRaw !== undefined && refRaw !== null && typeof refRaw !== "string") { errors.push(`${item.label}: the reference must be text.`); continue; }
    const reference = typeof refRaw === "string" ? refRaw.trim() : "";
    if (reference.length > MAX_REFERENCE) { errors.push(`${item.label}: the reference is too long (at most ${MAX_REFERENCE} characters).`); continue; }
    store[key] = { note, ...(reference ? { reference } : {}), by: email, at: nowIso, priceHash: manualPriceHash(item) };
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  next.manualEvidence = store;
  next.revision = prior.revision + 1; // pricingDate is deliberately NOT changed: no price moves
  const changes = diffPricing(prior, next);
  if (changes.length === 0) return { ok: false, errors: ["Nothing changed."] };
  return { ok: true, next, changes };
}
