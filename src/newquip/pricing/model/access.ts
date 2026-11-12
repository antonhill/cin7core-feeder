import { stableStringify } from "../../quote/baseline";
import type { QuoteRole } from "../../quote/roles";
import type { PricingResult } from "./calculate";
import type { ForwardCover, ItemOverride, ProjectAdjustment, ProjectMarkupChange } from "./types";

// WHO MAY ENTER, WHO MAY SEE (NQ-008B Phase 1). Pure. Two independent gates, matching the rest of the NewQuip module:
//   • cost visibility (`canSeeCost`, resolved by the server from the org's cost-visibility setting) decides who may SEE cost, rates, freight, markup and margin;
//   • the Estimator or Manager role decides who may ENTER or CHANGE a pricing input (a rate, an override, a markup, an adjustment).
// Entering an input needs BOTH: every pricing input is itself a cost fact. The model invents no approval threshold: whether an adjustment needs a Manager's sign-off, and
// from what size, is an open commercial decision (see the Phase 1 report), so no such rule exists here.

export type QuoteRoleSet = ReadonlySet<QuoteRole>;
export interface Viewer { roles: QuoteRoleSet; canSeeCost: boolean }

export const canEnterPricingInputs = (v: Viewer): boolean => v.canSeeCost && (v.roles.has("estimator") || v.roles.has("manager"));

// ── what a viewer is given ─────────────────────────────────────────────────

export interface CustomerSafeLine { key: string; label: string; sku: string | null; status: "priced" | "not_priced"; quantity: number; unitPriceCents: number | null; revenueCents: number | null }
export interface CustomerSafePricing {
  audience: "customer_safe";
  /** Selling-price completeness only. Whether the COST is complete is cost information and is not part of this view. */
  completeness: PricingResult["priceCompleteness"];
  lines: CustomerSafeLine[];
  /** The sum of the priced lines. Not the project total unless `totalExVatCents` is present. */
  pricedSubtotalCents: number;
  /** A project adjustment is a selling figure, so its amount is shown, as its own line, without the reason behind it. */
  adjustmentCents: number | null;
  /** null while any line is unpriced: a total that leaves a line out would understate the quotation. */
  totalExVatCents: number | null;
}
export interface InternalPricing { audience: "internal"; result: PricingResult }

/** The whole result for a cost-entitled viewer; for anyone else a reduced copy built field by field (never a filtered copy), so a new field can never leak by default. */
export function viewPricing(result: PricingResult, viewer: Viewer): InternalPricing | CustomerSafePricing {
  if (viewer.canSeeCost) return { audience: "internal", result };
  return {
    audience: "customer_safe",
    completeness: result.priceCompleteness,
    pricedSubtotalCents: result.pricedSubtotalCents,
    lines: result.lines.map((l) => ({ key: l.key, label: l.label, sku: l.sku, status: l.status, quantity: l.quantity, unitPriceCents: l.unitPriceCents, revenueCents: l.revenueCents })),
    adjustmentCents: result.adjustment?.applied ? result.adjustment.amountCents : null,
    totalExVatCents: result.totalExVatCents,
  };
}

// ── entering inputs: server-owned attribution ──────────────────────────────

export interface PricingInputRecord {
  forwardCover: Record<string, ForwardCover | undefined>;
  itemOverrides: Record<string, ItemOverride | undefined>;
  projectMarkup: ProjectMarkupChange | null;
  projectAdjustment: ProjectAdjustment | null;
}
export const emptyInputRecord = (): PricingInputRecord => ({ forwardCover: {}, itemOverrides: {}, projectMarkup: null, projectAdjustment: null });

/** The content of an input without its attribution, so "unchanged" means the VALUE and REASON are unchanged. */
const content = (x: unknown): string => stableStringify(JSON.parse(JSON.stringify(x ?? null), (k, v) => (k === "by" || k === "at" ? undefined : k === "reason" && typeof v === "string" ? v.trim() : v)));

function stampOne<T extends { by: string; at: string; reason: string }>(next: T | null | undefined, prior: T | null | undefined, who: string, nowIso: string): T | null {
  if (!next) return null;
  if (prior && content(prior) === content(next)) return prior; // unchanged: keep the earlier attribution and ignore whatever the client sent
  return { ...next, reason: next.reason.trim(), by: who, at: nowIso };
}

/**
 * Returns the inputs with attribution decided by the SERVER: unchanged entries keep their original who/when, new or changed ones are stamped with the actor and the time,
 * and anything a client sent for `by` / `at` is discarded. Throws a plain message when the viewer may not make the change (including removing an entry).
 */
export function stampPricingInputs(submitted: PricingInputRecord, prior: PricingInputRecord, viewer: Viewer, email: string, nowIso: string): PricingInputRecord {
  const out = emptyInputRecord();
  const changes: boolean[] = [];
  const mark = (a: unknown, b: unknown) => changes.push(content(a) !== content(b));

  for (const cur of new Set([...Object.keys(submitted.forwardCover), ...Object.keys(prior.forwardCover)])) {
    const n = stampOne(submitted.forwardCover[cur], prior.forwardCover[cur], email, nowIso);
    mark(n, prior.forwardCover[cur]);
    if (n) out.forwardCover[cur] = n;
  }
  for (const key of new Set([...Object.keys(submitted.itemOverrides), ...Object.keys(prior.itemOverrides)])) {
    const s = submitted.itemOverrides[key], p = prior.itemOverrides[key];
    const price = stampOne(s?.price, p?.price, email, nowIso), quantity = stampOne(s?.quantity, p?.quantity, email, nowIso);
    mark(price, p?.price); mark(quantity, p?.quantity);
    if (price || quantity) out.itemOverrides[key] = { ...(price ? { price } : {}), ...(quantity ? { quantity } : {}) };
  }
  out.projectMarkup = stampOne(submitted.projectMarkup, prior.projectMarkup, email, nowIso); mark(out.projectMarkup, prior.projectMarkup);
  out.projectAdjustment = stampOne(submitted.projectAdjustment, prior.projectAdjustment, email, nowIso); mark(out.projectAdjustment, prior.projectAdjustment);

  if (changes.some(Boolean) && !canEnterPricingInputs(viewer)) throw new Error("Only an Estimator or Manager who can see costs can enter or change pricing inputs.");
  return out;
}
