import { computeLine, computeQuote, type QuoteLineInput, type QuoteResult } from "@/lib/quote-margin";
import { isOptionalItemKey } from "./types";
import { BUDGET_BASIS_PLAIN, budgetRateSellingPrice, usableBudgetBasis, type BudgetBasisEntry } from "./budget-basis";
import type { FeederVariant, GeneratedLine, GrowerItemKey, PenningPigSize } from "./types";
import { confirmedBudgetDefaultSku } from "./budget-default-products";
import { INTERIM_PANEL_PLAIN, INTERIM_PANEL_REASON, interimPanelRate, type PanelSelection } from "./control-panel-interim";
import { TEMPLATE_REVISION_LEGACY, TEMPLATE_REVISION_CURRENT, coolingPackageFor, type TemplateRevision, alternativesFor, estimatorPricedFor, feederSkuFor, isCatalogueDefaultItem, manualLinesFor, packageAutoConfirmable, packageFor, provisionalPackageBasis, recommendedSkuFor, type PackageComponent } from "./commercial";
import { PENNING_RATE_PER_RM } from "./workbook-price-source";
import { QUOTE_TYPE_BASIS, type PriceSource, type PriceSourceDescriptor, type QuoteType } from "./pricing-source";

// Feeds generated lines into the EXISTING quote engine (src/lib/quote-margin.ts). No tax, margin, GP or total arithmetic is
// re-implemented here. Prices come ONLY from the injected PriceSource (the NewQuip Master workbook snapshot for the POC).
// A line is only priced when it has a quantity, a confirmed product (or package) and a price from the source; anything else is
// reported — never defaulted to 0, never replaced by a historic surrogate. A PACKAGE contributes only when EVERY component is
// priced (a drinker without its pipe is not a price).
//
// Three kinds of line are priced by a person, not the price source, and each says so on the line:
//   • penning       rate × running metres (Sean's confirmed R/rm by pig size)
//   • M75           the estimator's commercial amount (manual by design)
//   • resolution    an estimator-resolved amount for a line the source cannot price (e.g. NQ3132 / FORTIS 1.2), with a reason

export type BridgeLineStatus =
  | "priced"
  | "no_quantity"
  | "not_selected"
  | "unmapped"
  | "not_in_price_source"
  | "supplier_quote_required"
  | "package_unconfirmed"
  | "package_incomplete"
  | "estimator_price_required";

export type BridgeComponentStatus = "priced" | "identity_unresolved" | "not_in_price_source" | "supplier_quote_required" | "reference_only";

/** Who/what produced a line's price — shown on the estimator view and frozen in the baseline. */
export type PricedBy = "price_source" | "penning_rate" | "estimator_input" | "estimator_resolution" | "budget_rate";

/** Commercial charges the ESTIMATOR enters by hand (no automatic freight/installation model — Sean Round 2 #12). */
export type ChargeKey = "delivery" | "installation" | "commissioning" | "concrete_slat_delivery";
export const CHARGE_LABEL: Record<ChargeKey, string> = {
  delivery: "Delivery",
  installation: "Installation",
  commissioning: "Commissioning",
  concrete_slat_delivery: "Concrete slat delivery",
};
export interface BridgeCharge {
  key: ChargeKey;
  label: string;
  /** Estimator-entered ex-VAT amount, or null while not entered. */
  amountExTax: number | null;
  status: "entered" | "required";
}

export interface BridgeComponent {
  id: string;
  sku: string | null;
  description: string;
  qtyPerUnit: number | null;
  /** Total component quantity for the order (qtyPerUnit × package units), or null if not knowable. */
  quantity: number | null;
  status: BridgeComponentStatus;
  reason: string;
  unitPrice: number | null;
  revenueExTax: number | null;
  estimatedCost: number | null;
}

export interface BridgeLine {
  itemKey: GeneratedLine["itemKey"];
  label: string;
  status: BridgeLineStatus;
  reason: string;
  /** The product actually priced (the mapped / variant SKU), when there is one. */
  sku: string | null;
  quantity: number | null;
  unitPrice: number | null;
  revenueExTax: number | null;
  /** Landed cost × quantity; null when unknown or withheld. */
  estimatedCost: number | null;
  estimatedGP: number | null;
  marginPct: number | null;
  pricedBy: PricedBy | null;
  /** Present for package outputs. */
  components?: BridgeComponent[];
  /** Set ONLY by a Budget evaluation (BudgetOptions.provisionalPackages) on a package priced provisionally, i.e. WITHOUT the Estimator's confirmation. Rep-safe: plain wording only, never a product code, cost or rate. */
  provisional?: { plain: string };
  /** Where the product came from: the established catalogue default (no Estimator decision needed) or an explicit per-quotation Estimator confirmation. Absent when no product is mapped. */
  mappingSource?: "catalogue_default" | "estimator" | "budget_default";
}

/** How much of the quote can be trusted as money. Never show a zero total as a quote. */
export type BudgetState = "awaiting_pricing" | "partial" | "complete";

export interface EstimatorResolution {
  unitPriceExVat: number;
  reason: string;
  /** Server-stamped provenance (who/when this manual quotation price was entered or last changed). */
  by?: string;
  at?: string;
}

export interface BudgetQuote {
  lines: BridgeLine[];
  totals: QuoteResult;
  state: BudgetState;
  /** Outputs (a package counts once) that are fully priced. */
  pricedLineCount: number;
  /** True while any line that should be on the quote is missing a quantity/mapping/price. */
  incomplete: boolean;
  blockers: string[];
  /**
   * The subset of `blockers` only an Estimator / Manager can clear (product mapping, package confirmation, supplier quote, missing source price).
   * Every other blocker (quantity, override reason, charge amounts, M75 price, pig size) is Rep-owned. Additive: `blockers` is unchanged.
   */
  estimatorBlockers: string[];
  /** Non-blocking notes (e.g. an unneeded price resolution). */
  warnings: string[];
  charges: BridgeCharge[];
  quoteType: QuoteType;
  /** What the selling price is derived from for this quote type. */
  pricingBasis: string;
  priceSource: PriceSourceDescriptor;
}

export interface BudgetOptions {
  priceSource: PriceSource;
  quoteType: QuoteType;
  taxRatePct: number;
  taxInclusive: boolean;
  /** Single-SKU products an estimator has confirmed (item → SKU). The feeder follows its variant. */
  confirmedMappings?: Partial<Record<GrowerItemKey, string>>;
  /** Output items whose package definition an estimator has confirmed. */
  confirmedPackages?: ReadonlySet<GrowerItemKey>;
  feederVariant?: FeederVariant;
  /** The door specification the Rep chose (door-sizes.ts), or null when no size is chosen. Current template, Budget basis only. */
  doorSpecification?: string | null;
  /** The template revision the quotation was created under (default: the ORIGINAL template, so nothing that omits it can be re-scoped). */
  templateRevision?: TemplateRevision;
  penningPigSize?: PenningPigSize | null;
  /** Estimator-entered ex-VAT delivery / installation / slat-delivery amounts. */
  estimatorCharges?: Partial<Record<ChargeKey, number | null>>;
  /** Estimator's commercial UNIT price (ex VAT) for lines that are estimator-priced by design (M75: per system). */
  estimatorUnitPrices?: Partial<Record<GrowerItemKey, number | null>>;
  /**
   * BUDGET evaluation only (default OFF; the default engine is unchanged). A package that awaits the Estimator's confirmation but whose composition is evidence-complete (see
   * provisionalPackageBasis) is priced through the SAME calculation and marked `provisional`. Never confirms anything; never set by readiness, hand-off, sign-off, approval or baselines.
   */
  provisionalPackages?: boolean;
  /**
   * BUDGET evaluation only. NewQuip-APPROVED default products / dated rates (budget-basis.ts) for an item that has no Estimator-confirmed product (the door and the optional equipment). Used only when the Estimator has confirmed
   * nothing for that item; the line is PROVISIONAL, goes through the existing price-source / markup rules and confirms nothing. Default: none (every other caller is unchanged).
   */
  budgetBasis?: readonly BudgetBasisEntry[];
  /** ISO date the register entries are checked against (default: today). */
  budgetAsOf?: string;
  /** The markup (basis points on cost) a COST-basis rate passes through: the project's attributed markup. null / absent = a cost-basis rate cannot be priced. */
  budgetMarkupBps?: number | null;
  /** The length (m) of ONE sumpless pad-cooling system. Used only on the current template; absent = the cooling line asks for it and stays unpriced. */
  coolingSystemLengthM?: number | null;
  /** BUDGET evaluation only: which of the CL1 controller / BF weighing the room has, for the interim control-panel amount (control-panel-interim.ts). */
  panelSelection?: PanelSelection | null;
  /** Estimator-resolved unit prices for lines the source cannot price. Used ONLY when the normal route fails; needs a reason. */
  priceResolutions?: Partial<Record<GrowerItemKey, EstimatorResolution>>;
  /**
   * True when the viewer may not see cost/ROE/freight/mark-up. Cost is then absent from the output and no GP / margin is
   * reported.
   */
  withholdCost?: boolean;
}

const emptyLine = (g: GeneratedLine) => ({
  itemKey: g.itemKey,
  label: g.label,
  sku: null as string | null,
  quantity: g.projectQuantity,
  unitPrice: null as number | null,
  revenueExTax: null as number | null,
  estimatedCost: null as number | null,
  estimatedGP: null as number | null,
  marginPct: null as number | null,
  pricedBy: null as PricedBy | null,
});

const isAmount = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/**
 * A COMMERCIAL CHARGE (delivery, installation, slat delivery) is ENTERED when it is a finite number >= 0. Blank/unset (null/undefined) is NOT entered, so the Rep must still decide;
 * an explicit 0 is a deliberate "no charge" and is kept visible (a warning, an "entered" status). A negative amount is never accepted. A PRODUCT price (isAmount) stays strictly positive.
 */
const isChargeEntered = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validResolution = (r: EstimatorResolution | undefined): r is EstimatorResolution => Boolean(r && isAmount(r.unitPriceExVat) && r.reason?.trim());

/** The SKU an item is expected to map to (the feeder follows its variant; others use the source-backed recommendation). */
export function expectedSkuFor(itemKey: GrowerItemKey, feederVariant?: FeederVariant): string | null {
  if (itemKey === "feeder") return feederSkuFor(feederVariant);
  return recommendedSkuFor(itemKey)?.recommendedSku ?? null;
}

function evaluateComponent(
  c: PackageComponent,
  packageUnits: number,
  opts: BudgetOptions,
): { comp: BridgeComponent; input: QuoteLineInput | null } {
  const base = {
    id: c.id, sku: c.sku, description: c.description, qtyPerUnit: c.qtyPerUnit,
    quantity: c.quantityStatus === "source_fixed" && c.qtyPerUnit != null ? (c.roundUpTotal ? Math.ceil(Math.round(c.qtyPerUnit * packageUnits * 1e9) / 1e9) : c.qtyPerUnit * packageUnits) : null,
    unitPrice: null as number | null, revenueExTax: null as number | null, estimatedCost: null as number | null,
  };
  // Identity first: an uncertain/unidentified component can't be priced, whatever its quantity — and a historic surrogate is never substituted.
  if (!c.sku) return { comp: { ...base, status: "identity_unresolved", reason: c.skuRequired ?? (c.identity === "uncertain" ? "SKU identity not settled — awaiting NewQuip" : "No SKU identified in the source") }, input: null };
  // A flagged pricing exception (NQ3132) is N/A — supplier quote required, whatever the quantity or the catalogue says.
  if (c.pricingException) return { comp: { ...base, status: "supplier_quote_required", reason: c.pricingException }, input: null };
  if (c.quantityStatus !== "source_fixed" || c.qtyPerUnit == null) return { comp: { ...base, status: "reference_only", reason: "Historic reference only — layout-driven quantity is not an engineering rule" }, input: null };
  const r = opts.priceSource.priceFor(c.sku, opts.quoteType);
  if (r.status === "supplier_quote_required") return { comp: { ...base, status: "supplier_quote_required", reason: r.reason }, input: null };
  if (r.status === "not_in_source") return { comp: { ...base, status: "not_in_price_source", reason: r.reason }, input: null };
  const input: QuoteLineInput = { quantity: base.quantity!, unitPrice: r.unitPriceExVat, taxRatePct: opts.taxRatePct, averageCost: r.landedCostExVat };
  const line = computeLine(input, { taxInclusive: opts.taxInclusive });
  return { comp: { ...base, status: "priced", reason: "Priced", unitPrice: r.unitPriceExVat, revenueExTax: line.revenueExTax, estimatedCost: line.estimatedCost }, input };
}

/**
 * Customer-facing name NewQuip confirmed on 2026-11-25 (handoff section 9). The LED's FERAX name (section 10) is NOT applied: the Rep-safe document guard forbids that brand until the owner decides, applied ONLY to a quotation on the current template revision: the original template, its saved snapshots and every quotation
 * created under it keep the wording they were issued with.
 */
export const CURRENT_REVISION_LABELS: Partial<Record<GrowerItemKey, string>> = {
  cup_drinker: "Sow Cup Drinker Including Mounting Material",
};
const relabelForRevision = (generated: GeneratedLine[], revision: TemplateRevision | undefined): GeneratedLine[] =>
  revision === TEMPLATE_REVISION_LEGACY || revision === undefined ? generated : generated.map((g) => (CURRENT_REVISION_LABELS[g.itemKey] ? { ...g, label: CURRENT_REVISION_LABELS[g.itemKey] as string } : g));

export function buildBudgetQuote(generated: GeneratedLine[], opts: BudgetOptions): BudgetQuote {
  generated = relabelForRevision(generated, opts.templateRevision);
  const bridge: BridgeLine[] = [];
  const engineLines: QuoteLineInput[] = [];
  const blockers: string[] = [];
  const estimatorBlockers: string[] = [];
  const warnings: string[] = [];
  let pricedOutputs = 0;
  const withhold = Boolean(opts.withholdCost);
  const sellRate = opts.taxRatePct;

  /** Price a line from an explicit unit price that a person (not the price source) decided. */
  const priceByPerson = (g: GeneratedLine, unit: number, pricedBy: PricedBy, reason: string, sku: string | null = null): BridgeLine => {
    const input: QuoteLineInput = { quantity: g.projectQuantity!, unitPrice: unit, taxRatePct: sellRate, averageCost: null, excludedFromMargin: true };
    engineLines.push(input);
    pricedOutputs += 1;
    const r = computeLine(input, { taxInclusive: opts.taxInclusive });
    return { ...emptyLine(g), sku, status: "priced", reason, unitPrice: unit, revenueExTax: r.revenueExTax, pricedBy };
  };

  for (const g of generated) {
    if (g.basis === "not_selected") {
      bridge.push({ ...emptyLine(g), status: "not_selected", reason: "Optional — not selected." });
      continue;
    }
    if (g.projectQuantity == null) {
      bridge.push({ ...emptyLine(g), status: "no_quantity", reason: g.inputRequired ? `Estimator input required — ${g.inputRequired}` : "Estimator input required — enter the quantity." });
      blockers.push(`${g.label}: ${g.inputRequired ? `estimator input required — ${g.inputRequired}` : "quantity not yet entered by the estimator"}`);
      continue;
    }
    // An OVERRIDE (a human replacing a system default) must be explained. An estimator input by design needs no reason.
    if (g.basis === "manual_override" && !g.overrideReason) blockers.push(`${g.label}: override reason required`);

    // A separate manual charge (e.g. slat delivery) is never folded into the SKU.
    for (const m of manualLinesFor(g.itemKey)) {
      if (!isChargeEntered(opts.estimatorCharges?.[m.id as ChargeKey])) blockers.push(`${m.description}: estimator-entered amount required (separate from the SKU)`);
    }

    const resolution = opts.priceResolutions?.[g.itemKey];
    /** The line could not be priced the normal way: a valid estimator resolution rescues it (visibly), otherwise it blocks. */
    const fail = (line: Omit<BridgeLine, "pricedBy">, blocker: string): void => {
      if (validResolution(resolution)) {
        bridge.push({ ...priceByPerson(g, resolution.unitPriceExVat, "estimator_resolution", `MANUAL QUOTATION PRICE - exceptional, not from the approved price source (${line.reason}) - reason: ${resolution.reason.trim()}`, line.sku), components: line.components });
        return;
      }
      bridge.push({ ...line, pricedBy: null });
      blockers.push(blocker);
      estimatorBlockers.push(blocker);
    };

    // ---- penning: running metres × the confirmed rate for the pig size ----
    if (estimatorPricedFor(g.itemKey)) {
      const rate = opts.penningPigSize ? PENNING_RATE_PER_RM[opts.penningPigSize] : undefined;
      if (!rate) {
        bridge.push({ ...emptyLine(g), status: "estimator_price_required", reason: "Select the pig size so the running-metre rate applies." });
        blockers.push(`${g.label}: pig size required for the running-metre rate`);
        continue;
      }
      bridge.push(priceByPerson(g, rate, "penning_rate", `NewQuip penning by pig-size / running-metre basis: ${g.projectQuantity} rm × R${rate.toLocaleString("en-ZA")}/rm (${opts.penningPigSize!.toLowerCase()}).`));
      continue;
    }

    const revision = opts.templateRevision ?? TEMPLATE_REVISION_LEGACY;
    // Cooling (current template only): the package is built from the system length. No length = no price and no guess.
    if (g.itemKey === "pad_cooling" && revision === TEMPLATE_REVISION_CURRENT && !coolingPackageFor(opts.coolingSystemLengthM)) {
      fail({ ...emptyLine(g), status: "unmapped", reason: "Enter the length of one cooling system (metres) to price this item." }, `${g.label}: enter the cooling system length`);
      continue;
    }
    const pkg = g.itemKey === "pad_cooling" && revision === TEMPLATE_REVISION_CURRENT ? (coolingPackageFor(opts.coolingSystemLengthM) ?? undefined) : packageFor(g.itemKey, revision);

    // ---- M75: estimator-priced by design; the historic package is a reference only ----
    if (pkg?.estimatorPriced) {
      const unit = opts.estimatorUnitPrices?.[g.itemKey];
      const reference = pkg.components.map((c) => evaluateComponent(c, g.projectQuantity!, opts).comp)
        .map((c): BridgeComponent => (c.status === "priced" ? { ...c, status: "reference_only", reason: "Historic package reference — not priced (the estimator prices the M75 system)", unitPrice: null, revenueExTax: null, estimatedCost: null } : c));
      // An included system is a PRODUCT: it needs a real (positive) price; a zero is never a way round that (deliberately NOT relaxed with the charges).
      if (!isAmount(unit)) {
        bridge.push({ ...emptyLine(g), status: "estimator_price_required", reason: "M75 is estimator input by design — enter the commercial price per system (ex VAT).", components: reference });
        blockers.push(`${g.label}: estimator commercial price required (manual by design)`);
        continue;
      }
      bridge.push({ ...priceByPerson(g, unit, "estimator_input", "M75 system priced by the estimator (client preference, manual by design). NQ3132 is N/A / supplier quote required and is not separately priced."), components: reference });
      continue;
    }

    // ---- CONTROL PANEL: NewQuip's interim Budget amount (Budget evaluation, current template only; the Estimator's own confirmation or manual price always wins) ----
    if (g.itemKey === "control_panel" && opts.provisionalPackages === true && revision === TEMPLATE_REVISION_CURRENT && !opts.confirmedMappings?.control_panel && !validResolution(opts.priceResolutions?.control_panel)) {
      const panelRate = interimPanelRate(opts.panelSelection);
      if (panelRate != null) {
        bridge.push({ ...priceByPerson(g, panelRate, "budget_rate", INTERIM_PANEL_REASON), provisional: { plain: INTERIM_PANEL_PLAIN } });
        continue;
      }
    }

    // ---- PACKAGE ----
    if (pkg) {
      const evals = pkg.components.map((c) => evaluateComponent(c, g.projectQuantity!, opts));
      const comps = evals.map((e) => e.comp);
      const provisional = opts.provisionalPackages === true && !opts.confirmedPackages?.has(g.itemKey) && !packageAutoConfirmable(pkg) ? provisionalPackageBasis(pkg) : null;
      if (!opts.confirmedPackages?.has(g.itemKey) && !packageAutoConfirmable(pkg) && !provisional) {
        fail({ ...emptyLine(g), status: "package_unconfirmed", reason: "Package awaiting estimator confirmation.", components: comps }, `${g.label}: package awaiting confirmation`);
        continue;
      }
      const missing = comps.filter((c) => c.status !== "priced");
      if (missing.length > 0) {
        const sq = missing.filter((c) => c.status === "supplier_quote_required").length;
        fail(
          { ...emptyLine(g), status: sq > 0 ? "supplier_quote_required" : "package_incomplete", reason: `${missing.length} of ${comps.length} components not priced${sq > 0 ? ` (${sq} supplier quote required)` : ""}.`, components: comps },
          `${g.label}: ${missing.length} of ${comps.length} package components not priced`,
        );
        continue;
      }
      for (const e of evals) engineLines.push(e.input!);
      pricedOutputs += 1;
      const revenue = comps.reduce((a, c) => a + (c.revenueExTax ?? 0), 0);
      const cost = comps.reduce((a, c) => a + (c.estimatedCost ?? 0), 0);
      bridge.push({
        ...emptyLine(g), status: "priced", reason: provisional ? "Package priced provisionally from its components (not confirmed by the Estimator)." : "Package priced from its components.", pricedBy: "price_source", ...(provisional ? { provisional: { plain: provisional.plain } } : {}),
        revenueExTax: revenue, estimatedCost: withhold ? null : cost, estimatedGP: withhold ? null : revenue - cost,
        marginPct: withhold || revenue <= 0 ? null : ((revenue - cost) / revenue) * 100, components: comps,
      });
      continue;
    }

    // ---- SINGLE SKU ----
    const expected = expectedSkuFor(g.itemKey, opts.feederVariant);
    // An explicit Estimator confirmation is authoritative and is still validated against the expected product below. Without one, an established catalogue item resolves to its catalogue product.
    const explicit = opts.confirmedMappings?.[g.itemKey] ?? null;
    const defaulted = !explicit && isCatalogueDefaultItem(g.itemKey) ? expected : null;
    // BUDGET only: with no Estimator confirmation, the door / an optional item may use a NewQuip-APPROVED default product or dated rate (never confirms anything; the line is provisional).
    const isCurrentDoor = g.itemKey === "pvc_door" && revision === TEMPLATE_REVISION_CURRENT;
    // The door has one Budget basis PER SIZE: with no size chosen there is nothing to price from, and the line says so.
    const basis = !explicit && !defaulted && !validResolution(resolution) && opts.budgetBasis && !(isCurrentDoor && !opts.doorSpecification) ? usableBudgetBasis(opts.budgetBasis, g.itemKey, opts.budgetAsOf ?? new Date().toISOString().slice(0, 10), isCurrentDoor ? opts.doorSpecification ?? undefined : undefined) : null;
    if (basis?.kind === "rate") {
      const priced = budgetRateSellingPrice(basis, opts.budgetMarkupBps ?? null, opts.budgetAsOf ?? new Date().toISOString().slice(0, 10));
      if (priced) {
        bridge.push({ ...priceByPerson(g, priced.unitPriceExVat, "budget_rate", `Budget allowance (${basis.specification}), not an Estimator-confirmed product.`), provisional: { plain: BUDGET_BASIS_PLAIN } });
        continue;
      }
    }
    // NewQuip-CONFIRMED Budget default product (budget-default-products.ts): Budget evaluation, current template, nothing confirmed by the Estimator and no approved register entry. Provisional; a missing cost leaves the line unpriced.
    const confirmedDefault = !explicit && !defaulted && !basis && !validResolution(resolution) && opts.provisionalPackages === true && revision === TEMPLATE_REVISION_CURRENT && isOptionalItemKey(g.itemKey) ? confirmedBudgetDefaultSku(g.itemKey) : null;
    const basisSku = basis?.kind === "default_sku" ? basis.sku : confirmedDefault;
    const confirmed = explicit ?? defaulted ?? basisSku;
    const mapSource = defaulted ? "catalogue_default" : basisSku ? "budget_default" : "estimator";
    // pvc_door and the optional additional elements have no recommended SKU: the estimator's confirmed Cin7 choice IS the SKU. Everything else must be the expected one.
    // An item's expected product, or one of the alternatives NewQuip said are included for that SAME item (an Estimator choice: it replaces the item's product, it is never an extra line).
    const isAlternative = !!confirmed && alternativesFor(g.itemKey).some((a) => a.sku === confirmed);
    const sku = g.itemKey === "pvc_door" || isOptionalItemKey(g.itemKey) ? confirmed : confirmed && (confirmed === expected || isAlternative) ? confirmed : null;
    if (!sku) {
      fail({ ...emptyLine(g), status: "unmapped", reason: confirmed && expected ? `Confirmed ${confirmed} does not match the expected ${expected}.` : isCurrentDoor && !opts.doorSpecification ? "Choose the door size to price this item." : "Product mapping not yet confirmed." }, `${g.label}: product mapping ${expected ? `to ${expected} ` : ""}not confirmed`);
      continue;
    }
    const r = opts.priceSource.priceFor(sku, opts.quoteType);
    if (r.status === "supplier_quote_required") {
      fail({ ...emptyLine(g), sku, status: "supplier_quote_required", reason: r.reason, mappingSource: mapSource }, `${g.label}: ${sku} supplier quote required`);
      continue;
    }
    if (r.status === "not_in_source") {
      fail({ ...emptyLine(g), sku, status: "not_in_price_source", reason: r.reason, mappingSource: mapSource }, `${g.label}: ${sku} has no price in the price source`);
      continue;
    }
    const input: QuoteLineInput = { quantity: g.projectQuantity, unitPrice: r.unitPriceExVat, taxRatePct: sellRate, averageCost: r.landedCostExVat };
    engineLines.push(input);
    pricedOutputs += 1;
    const line = computeLine(input, { taxInclusive: opts.taxInclusive });
    bridge.push({
      ...emptyLine(g), sku, status: "priced", reason: basisSku ? "Priced provisionally from the approved Budget default product (not confirmed by the Estimator)." : "Priced from the price source.", pricedBy: "price_source", mappingSource: mapSource,
      ...(basisSku ? { provisional: { plain: BUDGET_BASIS_PLAIN } } : {}),
      unitPrice: r.unitPriceExVat, revenueExTax: line.revenueExTax,
      estimatedCost: withhold ? null : line.estimatedCost, estimatedGP: withhold ? null : line.estimatedGP, marginPct: withhold ? null : line.marginPct,
    });
  }

  // A resolution that was not needed is surfaced, never silently applied.
  for (const [k, r] of Object.entries(opts.priceResolutions ?? {})) {
    const b = bridge.find((l) => l.itemKey === k);
    if (r && b && b.pricedBy !== "estimator_resolution" && b.pricedBy !== "budget_rate") warnings.push(`${b.label}: an estimator price resolution was entered but is not needed — the price source prices this line.`);
  }

  // Estimator-entered commercial charges (separate lines; uncosted, so they never touch the margin).
  const anyQuantified = generated.some((g) => g.basis !== "not_selected" && g.projectQuantity != null);
  const charges: BridgeCharge[] = (Object.keys(CHARGE_LABEL) as ChargeKey[])
    // Commissioning is OPTIONAL: it appears only once a person has entered it (an unset value adds no line, no blocker and changes no existing quotation).
    .filter((k) => k !== "commissioning" || isChargeEntered(opts.estimatorCharges?.commissioning))
    .filter((k) => k !== "concrete_slat_delivery" || generated.some((g) => g.itemKey === "concrete_slat" && g.basis !== "not_selected" && g.projectQuantity != null))
    .map((k) => {
      const v = opts.estimatorCharges?.[k];
      return { key: k, label: CHARGE_LABEL[k], amountExTax: isChargeEntered(v) ? v : null, status: isChargeEntered(v) ? ("entered" as const) : ("required" as const) };
    });
  for (const c of charges) {
    if (c.amountExTax != null) {
      // An explicit R0.00 is kept (visible, "entered") but is not a priced line: nothing is added to the total, the margin or the customer's quotation.
      if (c.amountExTax > 0) engineLines.push({ quantity: 1, unitPrice: c.amountExTax, taxRatePct: sellRate, averageCost: null, excludedFromMargin: true });
      else warnings.push(`${c.label}: R0.00 entered - no charge is quoted.`);
    } else if (c.key !== "concrete_slat_delivery" && c.key !== "commissioning" && anyQuantified) {
      blockers.push(`${c.label}: estimator-entered amount required`);
    }
  }

  const incomplete = blockers.length > 0;
  const state: BudgetState = pricedOutputs === 0 ? "awaiting_pricing" : incomplete ? "partial" : "complete";
  const totals = computeQuote(engineLines, { taxInclusive: opts.taxInclusive });
  // A viewer who may not see cost must not receive it through ANY field — including per-component cost inside a package.
  const lines = withhold
    ? bridge.map((l) => ({ ...l, estimatedCost: null, estimatedGP: null, marginPct: null, components: l.components?.map((c) => ({ ...c, estimatedCost: null })) }))
    : bridge;
  return {
    lines,
    // …nor through the totals.
    // (marginRevenueExTax, costedLineCount and excludedFromMarginCount are margin-derived: they reveal which lines carry a cost and the costed revenue.)
    totals: withhold ? { ...totals, estimatedCost: 0, estimatedGP: 0, overallMarginPct: null, marginRevenueExTax: 0, costedLineCount: 0, excludedFromMarginCount: 0 } : totals,
    state,
    pricedLineCount: pricedOutputs,
    incomplete,
    blockers,
    estimatorBlockers,
    warnings,
    charges,
    quoteType: opts.quoteType,
    pricingBasis: QUOTE_TYPE_BASIS[opts.quoteType],
    priceSource: opts.priceSource.descriptor,
  };
}
