import { createHash } from "node:crypto";
import { GROWER_RULESET_VERSION, GROWER_TEMPLATE, POC_TAX } from "../grower/final-feedback";
import { GROWER_RULES } from "../grower/rules";
import type { QuoteDraft } from "../grower/draft";
import type { QuoteEvaluation } from "../grower/evaluate";
import type { PricedBy } from "../grower/quote-bridge";
import type { PriceSourceDescriptor, QuoteType } from "../grower/pricing-source";
import type { GrowerConfigurationInput } from "../grower/types";
import { buildMarginSheet, type MarginSheet } from "./margin";
import { buildPhysicalScope } from "./physical-scope";
import { applyMappingLibrary, type LibraryMapping, type ScopeItem } from "@/lib/projects/product-scope";
import type { CostEstimate } from "@/lib/projects/latest-cost";
import { baselineMappingGate, blockerLabel, incompleteEstimateMessage, validateExceptionReason, BASELINE_EXCEPTION_KIND, BASELINE_EXCEPTION_TITLE, type BaselineException } from "./baseline-exception";

// THE ACCEPTED BASELINE — the immutable commercial snapshot a manager's final approval creates, and the only thing a Project is
// built from. It records everything needed to explain the contract later WITHOUT re-running any rule or re-reading any price:
// later rule or price changes can never alter it (it is deep-frozen and hash-sealed; the database also refuses to change it).
// Cost, ROE and freight are deliberately NOT in it. The one exception is `internalMargin`: the INTERNAL margin sheet frozen at approval
// (selling, estimated cost, gross profit, margin and markup per product/assembly/section/project). It is never copied to a Project
// baseline and never shown to customers (quoteToProjectBaseline ignores it; the customer summary is built separately).

export interface BaselineCommercialLine {
  itemKey: string;
  label: string;
  sku: string | null;
  quantity: number;
  unitPriceExVat: number | null;
  revenueCents: number;
  pricedBy: PricedBy | null;
  note: string;
  components?: { sku: string | null; description: string; quantity: number | null; unitPriceExVat: number | null; revenueCents: number | null; status: string }[];
}

export interface AcceptedBaseline {
  schemaVersion: 1;
  quote: { ref: string; revision: number; customerName: string; siteName: string; quoteType: QuoteType };
  template: { id: string; name: string; version: string; rulesetVersion: string };
  /** The rule table that produced the outputs: id + how firmly established + how the quantity is decided. */
  rules: { ruleId: string; itemKey: string; classification: string; treatment: string }[];
  configuration: GrowerConfigurationInput;
  estimator: QuoteDraft["estimator"];
  calculatedOutputs: {
    floorAreaM2: number | null;
    rooms: number | null;
    lines: { itemKey: string; ruleId: string; basis: string; quantityPerRoom: number | null; projectQuantity: number | null; defaultQuantityPerRoom: number | null; suggestedQuantityPerRoom: number | null; overrideReason: string | null; exclusionReason: string | null }[];
  };
  selectedProducts: { itemKey: string; sku: string | null; variant: string | null }[];
  overrides: { itemKey: string; quantityPerRoom: number | null; defaultQuantityPerRoom: number | null; reason: string | null }[];
  exclusions: { itemKey: string; reason: string }[];
  priceResolutions: { itemKey: string; unitPriceExVat: number; reason: string; /** Server-stamped provenance (who/when), sealed with the baseline. */ by?: string; at?: string }[];
  pricing: { source: PriceSourceDescriptor; quoteType: QuoteType; basis: string };
  commercial: {
    lines: BaselineCommercialLine[];
    charges: { key: string; label: string; amountCents: number }[];
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    taxRule: string;
    taxRateBps: number;
    taxInclusive: boolean;
  };
  assumptions: string;
  approvals: {
    customerConfirmedAt: string;
    customerConfirmedCents: number;
    customerConfirmedBy: string;
    handoffBy: string;
    estimatorSignoffBy: string;
    estimatorSignoffAt: string;
    managerApprovedBy: string;
    managerApprovedAt: string;
  };
  /**
   * The approved PHYSICAL product scope (SKU, quantity, unit, type, package/section origin, selling price), frozen and sealed with the baseline.
   * Customer-safe: no cost, no margin. Absent on baselines sealed before it existed; it is then rebuilt identically from `commercial.lines`.
   */
  physicalScope?: ScopeItem[];
  /** INTERNAL ONLY. Frozen with the baseline so later price or cost changes cannot rewrite the agreed margin. Absent on baselines sealed before margins existed. */
  internalMargin?: MarginSheet;
  /** INTERNAL. The physical-SKU cost estimate (Cin7 latest cost / audited manual estimates) frozen at approval. Absent when no costs were captured. Never changes afterwards. */
  physicalCostEstimate?: CostEstimate & { costBasis?: { unitBasis?: unknown; incompleteAccepted?: { reason: string; by: string; at: string } } };
  /**
   * Manager-recorded exceptions accepted at approval (additive; absent on baselines sealed before it existed). Today one kind: Estimator-priced systems without a Cin7 SKU mapping.
   * Sealed with the baseline, so it can never be hidden or edited afterwards.
   */
  exceptions?: BaselineException[];
  /** Total contract value, ex VAT, integer cents. */
  contractCents: number;
}

const cents = (rands: number): number => Math.round(rands * 100);

/** Deterministic JSON: keys sorted, so the hash does not depend on property order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export const hashOf = (v: unknown): string => createHash("sha256").update(stableStringify(v)).digest("hex");

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o as object)) deepFreeze((o as Record<string, unknown>)[k]);
  }
  return o;
}

export interface BaselineInput {
  quoteRef: string;
  revision: number;
  draft: QuoteDraft;
  evaluation: QuoteEvaluation;
  approvals: AcceptedBaseline["approvals"];
  /** The same draft evaluated with cost VISIBLE, used only for the internal margin sheet. Defaults to `evaluation`. Its selling figures must equal the evaluation's. */
  marginEvaluation?: QuoteEvaluation;
  /** ACTIVE reusable package mappings at approval time. Applied to unmapped scope items and frozen (with their versions) into the sealed baseline. */
  mappingLibrary?: ReadonlyMap<string, LibraryMapping>;
  /**
   * A Manager's accepted-incomplete exception for Estimator-priced systems without a Cin7 SKU. `draftHash` is the stored hash of the exact content being frozen; the caller has
   * already bound it to the version the Manager saw. It waives ONLY the unmapped Estimator-priced items; anything else still stops the freeze.
   */
  baselineException?: { reason: string; draftHash: string };
}

type Budget = NonNullable<QuoteEvaluation["budget"]>;
/** The priced commercial lines of an evaluated budget, exactly as they are sealed (also used for the pre-approval scope view, so both always agree). */
export function commercialLinesOf(b: Budget): BaselineCommercialLine[] {
  return b.lines
    .filter((l) => l.status === "priced")
    .map((l) => ({
      itemKey: l.itemKey, label: l.label, sku: l.sku, quantity: l.quantity ?? 0, unitPriceExVat: l.unitPrice, revenueCents: cents(l.revenueExTax ?? 0),
      pricedBy: l.pricedBy, note: l.reason,
      ...(l.components ? { components: l.components.map((c) => ({ sku: c.sku, description: c.description, quantity: c.quantity, unitPriceExVat: c.unitPrice, revenueCents: c.revenueExTax == null ? null : cents(c.revenueExTax), status: c.status })) } : {}),
    }));
}

/** Builds the sealed baseline. Throws unless the evaluated quote is READY — an incomplete quote can never be frozen. */
export function buildAcceptedBaseline(i: BaselineInput): { baseline: AcceptedBaseline; hash: string } {
  const { evaluation: ev, draft } = i;
  if (ev.readiness.state !== "READY" || !ev.budget || ev.budget.incomplete) throw new Error("Cannot freeze a quote that is not READY.");
  const b = ev.budget;
  const marginBudget = (i.marginEvaluation ?? ev).budget;
  if (!marginBudget || Math.round(marginBudget.totals.subtotalExTax * 100) !== Math.round(b.totals.subtotalExTax * 100)) throw new Error("The margin evaluation does not match the quote being frozen.");
  const subtotalCents = cents(b.totals.subtotalExTax);

  const lines = commercialLinesOf(b);

  const physicalScope = i.mappingLibrary && i.mappingLibrary.size ? applyMappingLibrary(buildPhysicalScope(lines), i.mappingLibrary, i.approvals.managerApprovedAt) : buildPhysicalScope(lines);
  const gate = baselineMappingGate({ lines, scope: physicalScope, physicalCosts: draft.estimator.physicalCosts, costExceptionAccepted: !!draft.estimator.costBasis?.incompleteAccepted });
  const builtEstimate = gate.estimate;
  // Unmapped packages block the freeze whether or not costing has started; a missing supplier cost blocks once costing has started. Neither can be frozen, unless an authorised user recorded an explicit, reasoned exception (frozen with it).
  // A Manager's baseline exception covers ONLY the Estimator-priced systems without a Cin7 SKU; any other unresolved package or missing supplier cost still refuses.
  let exceptions: BaselineException[] | undefined;
  if (gate.blocked) {
    const bx = i.baselineException;
    if (!bx) throw new Error(incompleteEstimateMessage(gate.missingSkus, [...gate.items.map((x) => x.label), ...gate.remainingPackages], { packageNames: [...gate.items.map((x) => x.label), ...gate.remainingPackages.map(blockerLabel)], needsMapping: gate.blocking.length > 0 }));
    const bad = validateExceptionReason(bx.reason);
    if (bad) throw new Error(bad);
    if (!gate.required) throw new Error(incompleteEstimateMessage(gate.missingSkus, gate.remainingPackages, { packageNames: gate.remainingPackages.map(blockerLabel), needsMapping: gate.blocking.length > 0 }));
    exceptions = [{
      kind: BASELINE_EXCEPTION_KIND, title: BASELINE_EXCEPTION_TITLE, unresolved: gate.items, reason: bx.reason.trim(),
      approvedBy: i.approvals.managerApprovedBy, approvedAt: i.approvals.managerApprovedAt, version: { quoteRef: i.quoteRef, revision: i.revision, draftHash: bx.draftHash },
    }];
  } else if (i.baselineException) throw new Error("No baseline exception applies to this quotation: nothing Estimator-priced is blocking the freeze.");
  const physicalCostEstimate = builtEstimate ? { ...builtEstimate, ...(draft.estimator.costBasis ? { costBasis: structuredClone(draft.estimator.costBasis) } : {}) } : undefined;
  const baseline: AcceptedBaseline = {
    schemaVersion: 1,
    quote: { ref: i.quoteRef, revision: i.revision, customerName: draft.customerName.trim(), siteName: draft.siteName.trim(), quoteType: draft.quoteType },
    template: { id: GROWER_TEMPLATE.id, name: GROWER_TEMPLATE.name, version: GROWER_TEMPLATE.version, rulesetVersion: GROWER_RULESET_VERSION },
    rules: GROWER_RULES.map((r) => ({ ruleId: r.id, itemKey: r.itemKey, classification: r.classification, treatment: r.treatment })),
    configuration: draft.config,
    estimator: draft.estimator,
    calculatedOutputs: {
      floorAreaM2: ev.calc.derived.floorAreaM2,
      rooms: ev.calc.derived.rooms,
      lines: ev.calc.lines.map((l) => ({
        itemKey: l.itemKey, ruleId: l.ruleId, basis: l.basis, quantityPerRoom: l.quantityPerRoom, projectQuantity: l.projectQuantity,
        defaultQuantityPerRoom: l.defaultQuantityPerRoom, suggestedQuantityPerRoom: l.suggestedQuantityPerRoom, overrideReason: l.overrideReason, exclusionReason: l.exclusionReason,
      })),
    },
    selectedProducts: lines.map((l) => ({ itemKey: l.itemKey, sku: l.sku, variant: l.itemKey === "feeder" ? (draft.config.feederVariant ?? "STANDARD") : null })),
    overrides: ev.calc.lines.filter((l) => l.overrideState === "manual_override").map((l) => ({ itemKey: l.itemKey, quantityPerRoom: l.quantityPerRoom, defaultQuantityPerRoom: l.defaultQuantityPerRoom, reason: l.overrideReason })),
    exclusions: ev.calc.lines.filter((l) => l.exclusionReason).map((l) => ({ itemKey: l.itemKey, reason: l.exclusionReason! })),
    priceResolutions: Object.entries(draft.estimator.priceResolutions).filter(([k]) => b.lines.some((l) => l.itemKey === k && l.pricedBy === "estimator_resolution")).map(([itemKey, r]) => ({ itemKey, unitPriceExVat: r!.unitPriceExVat, reason: r!.reason, ...(r!.by ? { by: r!.by } : {}), ...(r!.at ? { at: r!.at } : {}) })),
    pricing: { source: b.priceSource, quoteType: b.quoteType, basis: b.pricingBasis },
    commercial: {
      lines,
      charges: b.charges.filter((c) => c.amountExTax != null).map((c) => ({ key: c.key, label: c.label, amountCents: cents(c.amountExTax!) })),
      subtotalCents,
      taxCents: cents(b.totals.taxTotal),
      totalCents: cents(b.totals.totalIncTax),
      taxRule: POC_TAX.rule, taxRateBps: POC_TAX.rateBps, taxInclusive: POC_TAX.inclusive,
    },
    assumptions: draft.estimator.assumptions,
    approvals: i.approvals,
    physicalScope,
    internalMargin: buildMarginSheet(marginBudget, draft.estimator.costOverrides ?? {}),
    ...(physicalCostEstimate ? { physicalCostEstimate } : {}),
    ...(exceptions ? { exceptions } : {}),
    contractCents: subtotalCents,
  };
  return { baseline: deepFreeze(baseline), hash: hashOf(baseline) };
}

/** Verifies a stored baseline still matches the hash recorded at approval (tamper / drift check). */
export function baselineMatchesHash(baseline: unknown, hash: string): boolean {
  return hashOf(baseline) === hash;
}
