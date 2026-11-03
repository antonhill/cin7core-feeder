import type { PricedBy } from "../grower/quote-bridge";
import type { BaselineCommercialLine } from "./baseline";
import { effectiveScope, type ScopeItem } from "@/lib/projects/product-scope";
import { buildCostEstimate, type CostEstimate } from "@/lib/projects/latest-cost";

// THE BASELINE EXCEPTION (UX-006 S3): a MANAGER-recorded "accepted incomplete" for ESTIMATOR-PRICED systems that have no Cin7 SKU by design.
//
// The baseline freeze (`buildAcceptedBaseline`) refuses a costed quotation whose physical scope still has packages not mapped to Cin7 SKUs. Systems the Estimator prices
// by design (the M75 price, penning by the running metre, an Estimator price resolution) legitimately have no Cin7 SKU, so without this exception they could only be
// approved by waiving every cost problem. This exception waives EXACTLY those items and nothing else:
//   - not an unmapped product (including one the Estimator merely typed a price for), a package still to be confirmed, an item missing from the price source, a supplier quote still required;
//   - not a missing supplier cost, not READY, not costing completeness, not the confirmed amount, not the Estimator's sign-off.
// It is bound to the exact quotation version (revision + draft hash) it was recorded against, and is sealed into the accepted baseline (`exceptions[]`).
// Everything here is pure; the Manager role check and the persistence are in the store / action.

export const BASELINE_EXCEPTION_KIND = "ESTIMATOR_PRICED_WITHOUT_CIN7_SKU";
export const BASELINE_EXCEPTION_TITLE = "Accepted incomplete: Estimator-priced systems without Cin7 SKU mapping";
export const BASELINE_EXCEPTION_MIN_REASON = 10;

/**
 * The only pricing routes that are "Estimator-priced by design": the M75 price the Estimator enters, and penning priced per running metre. `estimator_resolution` is
 * deliberately NOT here: an Estimator can type a unit price on ANY blocking line (for example an unmapped or mismatched catalogue product), so a resolved price says nothing
 * about whether a Cin7 SKU should exist. Such a line keeps blocking the freeze until it is mapped.
 */
export const BY_DESIGN_PRICED_BY = ["estimator_input", "penning_rate"] as const satisfies readonly PricedBy[];
export type ByDesignPricedBy = (typeof BY_DESIGN_PRICED_BY)[number];
export const PRICED_BY_LABEL: Record<ByDesignPricedBy, string> = {
  estimator_input: "priced by the Estimator (entered price)",
  penning_rate: "priced per running metre (penning rate)",
};
const isByDesign = (p: PricedBy | null): p is ByDesignPricedBy => p != null && (BY_DESIGN_PRICED_BY as readonly string[]).includes(p);

export interface BaselineExceptionItem {
  itemKey: string;
  label: string;
  pricedBy: ByDesignPricedBy;
  /** How it is priced, in words. */
  pricing: string;
}

/** The record sealed into the accepted baseline (`baseline.exceptions[]`). */
export interface BaselineException {
  kind: typeof BASELINE_EXCEPTION_KIND;
  title: typeof BASELINE_EXCEPTION_TITLE;
  /** The unresolved items this exception covers. */
  unresolved: BaselineExceptionItem[];
  reason: string;
  approvedBy: string;
  approvedAt: string;
  /** The exact quotation version it is bound to. */
  version: { quoteRef: string; revision: number; draftHash: string };
}

/** What a Manager supplies; everything else (items, version, approver, time) is derived server-side. */
export interface BaselineExceptionRequest {
  reason: string;
  /** The version the Manager was looking at when they accepted it. A different current version refuses the approval. */
  expectedRevision: number;
  expectedDraftHash: string;
}

const UNMAPPED_SUFFIX = ":UNMAPPED";

/**
 * The scope items that are Estimator-priced BY DESIGN and unmapped: a whole line (not "remaining components" of a partly mapped package) with no resolution, whose
 * commercial line was priced via estimator_input / penning_rate. `blocker` is the exact text `effectiveScope` reports for it.
 */
export function estimatorPricedUnmapped(lines: readonly BaselineCommercialLine[], scope: readonly ScopeItem[]): Array<{ item: BaselineExceptionItem; blocker: string }> {
  const out: Array<{ item: BaselineExceptionItem; blocker: string }> = [];
  for (const it of scope) {
    if (it.resolution || it.mapping.status !== "UNMAPPED" || !it.id.endsWith(UNMAPPED_SUFFIX)) continue;
    const itemKey = it.id.slice(0, -UNMAPPED_SUFFIX.length);
    const line = lines.find((l) => l.itemKey === itemKey);
    if (!line || !isByDesign(line.pricedBy) || it.description !== line.label) continue;
    out.push({ item: { itemKey, label: line.label, pricedBy: line.pricedBy, pricing: PRICED_BY_LABEL[line.pricedBy] }, blocker: `${it.description}: ${it.mapping.reason}` });
  }
  return out;
}

export interface BaselineMappingGate {
  /** The cost estimate exactly as it is frozen (still honestly incomplete). Undefined: costing was never started, so the freeze rule does not apply. */
  estimate: CostEstimate | undefined;
  /** Would the freeze refuse WITHOUT a Manager baseline exception? */
  blocked: boolean;
  /** Estimator-priced unmapped items a Manager exception could cover. */
  items: BaselineExceptionItem[];
  /** Unresolved packages left once those are waived (these a Manager exception can never cover), and the SKUs with no supplier cost that are NOT waived by the Estimator's cost exception. */
  remainingPackages: string[];
  missingSkus: string[];
  /** TRUE when a Manager exception is required AND sufficient: waiving the listed items clears every reason the freeze would refuse. */
  required: boolean;
}

/**
 * The single source of truth for the freeze rule and for the exception: used by `buildAcceptedBaseline`, the approval check and the Manager workspace.
 *
 * The Estimator's cost exception (`costExceptionAccepted`) waives COST reasons only, i.e. SKUs with no supplier cost. It never waives an unmapped package: an Estimator-priced
 * system without a Cin7 SKU always needs the Manager's recorded exception, and any other unmapped package keeps blocking.
 */
export function baselineMappingGate(i: { lines: readonly BaselineCommercialLine[]; scope: readonly ScopeItem[]; physicalCosts: Parameters<typeof buildCostEstimate>[1] | undefined; costExceptionAccepted: boolean }): BaselineMappingGate {
  const captured = i.physicalCosts;
  const eff = captured && Object.keys(captured).length ? effectiveScope(i.scope) : null;
  const estimate = eff ? buildCostEstimate(eff.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity })), captured!, eff.blockers.length ? eff.blockers : []) : undefined;
  const waivable = estimate ? estimatorPricedUnmapped(i.lines, i.scope) : [];
  const covered = waivable.filter((w) => (estimate?.unresolvedPackages ?? []).includes(w.blocker));
  const remaining = [...(estimate?.unresolvedPackages ?? [])];
  for (const w of covered) { const at = remaining.indexOf(w.blocker); if (at >= 0) remaining.splice(at, 1); }
  const missingSkus = i.costExceptionAccepted ? [] : (estimate?.missingSkus ?? []);
  const blocked = !!estimate && (covered.length > 0 || remaining.length > 0 || missingSkus.length > 0);
  return {
    estimate, blocked, items: covered.map((w) => w.item), remainingPackages: remaining, missingSkus,
    required: blocked && covered.length > 0 && remaining.length === 0 && missingSkus.length === 0,
  };
}

/** The refusal text the freeze has always used, now counting only what an exception could NOT cover. */
export function incompleteEstimateMessage(missingSkus: readonly string[], packages: readonly string[]): string {
  const parts = [missingSkus.length ? `${missingSkus.length} SKU(s) have no supplier cost selected (${missingSkus.slice(0, 5).join(", ")}${missingSkus.length > 5 ? ", ..." : ""})` : "", packages.length ? `${packages.length} package(s) are not mapped to Cin7 SKUs` : ""].filter(Boolean);
  return `The cost estimate is incomplete: ${parts.join(" and ")}. Resolve each (select a supplier, enter an audited manual estimate, map the package) or record an authorised exception before approving.`;
}

export function validateExceptionReason(reason: string): string | null {
  if (reason.trim().length < BASELINE_EXCEPTION_MIN_REASON) return "A baseline exception needs a written reason (at least a short sentence).";
  return reason.trim().length > 1000 ? "The exception reason is too long (1000 characters at most)." : null;
}

/** One line for the approval decision text / history / audit summary. */
export function exceptionDecisionText(e: Pick<BaselineException, "unresolved" | "reason">): string {
  return `${BASELINE_EXCEPTION_TITLE}. Unresolved: ${e.unresolved.map((u) => `${u.label} [${u.itemKey}] (${u.pricing})`).join("; ")}. Reason: ${e.reason}`;
}

/** What the Manager workspace (and the Estimator's read-only note) shows. Pure; no cost value. */
export interface BaselineExceptionView {
  /** The Estimator's recorded cost exception, shown read-only for context (null when there is none). It waives cost reasons only. */
  costException?: { reason: string; by: string; at: string } | null;
  /** An exception is needed to approve and is sufficient. */
  baselineExceptionRequired: boolean;
  items: BaselineExceptionItem[];
  /** Reasons an exception can NOT cover (so approval stays blocked even with one). */
  otherBlockers: string[];
}
export function baselineExceptionView(g: Pick<BaselineMappingGate, "required" | "items" | "blocked" | "remainingPackages" | "missingSkus">, costException?: { reason: string; by: string; at: string } | null): BaselineExceptionView {
  return {
    costException: costException ?? null,
    baselineExceptionRequired: g.required,
    items: g.blocked ? g.items : [],
    otherBlockers: g.blocked ? [...g.remainingPackages, ...(g.missingSkus.length ? [`${g.missingSkus.length} SKU(s) have no supplier cost selected`] : [])] : [],
  };
}
